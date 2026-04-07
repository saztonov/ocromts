/**
 * Сквозной дамп всех LLM-обменов на диск.
 *
 * Принцип: каждый вызов callOpenRouter автоматически пишет _request/_response/_error
 * файлы в debug/<comparisonId>/<stage>/. Это позволяет разработчику в любой момент
 * посмотреть, что именно ушло в модель и что вернулось — без обращения к БД.
 *
 * Все функции мягко падают: ошибки записи логируются, но не валят пайплайн.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export interface DumpContext {
  /** ID сравнения, под которым создаётся подпапка в debug/. */
  comparisonId: string;
  /** Подпуть внутри comparisonId, например: 'stage_a/order' или 'stage_b/llm'. */
  stage: string;
  /** Префикс файла без расширения, например: '017_order' или '001'. */
  name: string;
}

function isEnabled(): boolean {
  return config.DEBUG_DUMP_ENABLED;
}

function dirFor(ctx: DumpContext): string {
  return path.join(config.DEBUG_DUMP_DIR, ctx.comparisonId, ctx.stage);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function safeWrite(filePath: string, content: string): void {
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    console.warn(`[llm-dump] failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function safeWriteBinary(filePath: string, data: Buffer): void {
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, data);
  } catch (err) {
    console.warn(`[llm-dump] failed to write binary ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Записывает request-payload. Если в messages есть image_url с base64,
 * вытаскивает их в отдельную папку <name>_request_images/ и заменяет ссылками.
 */
export function dumpRequest(ctx: DumpContext, payload: unknown): void {
  if (!isEnabled()) return;
  const dir = dirFor(ctx);
  const file = path.join(dir, `${ctx.name}_request.json`);

  // Глубокая «лёгкая» копия с выносом base64-картинок на диск.
  const cloned = stripBase64Images(payload, dir, `${ctx.name}_request_images`);

  safeWrite(file, JSON.stringify({ timestamp: new Date().toISOString(), ...(cloned as object) }, null, 2));
}

/** Записывает response-payload как JSON и одновременно plain-text content. */
export function dumpResponse(ctx: DumpContext, response: {
  elapsedMs: number;
  httpStatus: number;
  raw?: unknown;
  content: string;
  finishReason?: string;
  usage?: unknown;
  validJson?: boolean;
}): void {
  if (!isEnabled()) return;
  const dir = dirFor(ctx);
  const jsonFile = path.join(dir, `${ctx.name}_response.json`);
  const txtFile = path.join(dir, `${ctx.name}_response.txt`);
  safeWrite(jsonFile, JSON.stringify({ timestamp: new Date().toISOString(), ...response }, null, 2));
  safeWrite(txtFile, response.content);
}

/** Записывает информацию об ошибке/таймауте конкретной попытки. */
export function dumpError(ctx: DumpContext, err: unknown, meta: { attempt: number; willRetry: boolean; elapsedMs: number }): void {
  if (!isEnabled()) return;
  const dir = dirFor(ctx);
  const file = path.join(dir, `${ctx.name}_error_attempt${meta.attempt}.json`);
  const e = err instanceof Error ? err : new Error(String(err));
  safeWrite(
    file,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      errorName: e.name,
      errorMessage: e.message,
      stack: e.stack,
      ...meta,
    }, null, 2)
  );
}

/** Записывает уже распарсенный/нормализованный артефакт (после стадии). */
export function dumpParsed(ctx: DumpContext, parsed: unknown): void {
  if (!isEnabled()) return;
  const file = path.join(dirFor(ctx), `${ctx.name}_parsed.json`);
  safeWrite(file, JSON.stringify(parsed, null, 2));
}

/**
 * Универсальная запись произвольного JSON в debug/<comparisonId>/<relativePath>.
 * Используется для _summary.json, 00_meta.json, fuzzy candidates и т.п.
 */
export function dumpJson(comparisonId: string, relativePath: string, data: unknown): void {
  if (!isEnabled()) return;
  const file = path.join(config.DEBUG_DUMP_DIR, comparisonId, relativePath);
  safeWrite(file, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Dump aggregator — собирает request/response/parsed/error по многим позициям
// и сбрасывает одним all.json. Нужен чтобы Stage A (и другие построчные стадии)
// не плодили сотни мелких файлов.
// ─────────────────────────────────────────────────────────────────────────────

interface AggregatorEntry {
  position: number;
  request?: unknown;
  response?: unknown;
  parsed?: unknown;
  errors?: unknown[];
}

export interface DumpAggregator {
  readonly comparisonId: string;
  readonly stage: string;
  /** Базовая директория, куда можно сохранять картинки/файлы, вынесенные из request. */
  readonly baseDir: string;
  /** Имя подпапки для картинок (общая на весь агрегатор). */
  readonly imagesSubdir: string;
  record(position: number, kind: 'request' | 'response' | 'parsed' | 'error', data: unknown): void;
  flush(): void;
}

export function createDumpAggregator(comparisonId: string, stage: string): DumpAggregator {
  const entries = new Map<number, AggregatorEntry>();
  const baseDir = path.join(config.DEBUG_DUMP_DIR, comparisonId, stage);
  const imagesSubdir = 'all_request_images';

  function get(position: number): AggregatorEntry {
    let e = entries.get(position);
    if (!e) {
      e = { position };
      entries.set(position, e);
    }
    return e;
  }

  return {
    comparisonId,
    stage,
    baseDir,
    imagesSubdir,
    record(position, kind, data) {
      if (!isEnabled()) return;
      const e = get(position);
      if (kind === 'request') e.request = data;
      else if (kind === 'response') e.response = data;
      else if (kind === 'parsed') e.parsed = data;
      else {
        if (!e.errors) e.errors = [];
        e.errors.push(data);
      }
    },
    flush() {
      if (!isEnabled()) return;
      const items = Array.from(entries.values()).sort((a, b) => a.position - b.position);
      const file = path.join(baseDir, 'all.json');
      safeWrite(file, JSON.stringify({ timestamp: new Date().toISOString(), items }, null, 2));
    },
  };
}

/** Экспортируется для использования из llm.ts при записи через агрегатор. */
export function stripBase64ImagesExternal(payload: unknown, baseDir: string, imagesSubdir: string): unknown {
  return stripBase64Images(payload, baseDir, imagesSubdir);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Глубоко обходит payload, ищет message_part вида { type: 'image_url', image_url: { url: 'data:image/...;base64,...' } }
 * и заменяет url на относительную ссылку, сохраняя картинки в imagesSubdir.
 */
function stripBase64Images(payload: unknown, baseDir: string, imagesSubdir: string): unknown {
  const imagesDir = path.join(baseDir, imagesSubdir);
  let imageCount = 0;

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      // image_url part
      if (obj.type === 'image_url' && obj.image_url && typeof obj.image_url === 'object') {
        const inner = obj.image_url as { url?: string };
        if (typeof inner.url === 'string' && inner.url.startsWith('data:')) {
          imageCount++;
          const m = inner.url.match(/^data:(image\/[a-z]+);base64,(.*)$/i);
          if (m) {
            const ext = m[1]!.split('/')[1] ?? 'png';
            const filename = `image_${String(imageCount).padStart(3, '0')}.${ext}`;
            safeWriteBinary(path.join(imagesDir, filename), Buffer.from(m[2]!, 'base64'));
            return { type: 'image_url', image_url: { url: `./${imagesSubdir}/${filename}` } };
          }
        }
      }
      // file part with base64 file_data
      if (obj.type === 'file' && obj.file && typeof obj.file === 'object') {
        const f = obj.file as { filename?: string; file_data?: string };
        if (typeof f.file_data === 'string' && f.file_data.length > 1024) {
          imageCount++;
          const filename = f.filename ?? `file_${String(imageCount).padStart(3, '0')}.bin`;
          // file_data часто base64 — сохраняем как есть в файл с тем же именем
          try {
            safeWriteBinary(path.join(imagesDir, filename), Buffer.from(f.file_data, 'base64'));
            return { type: 'file', file: { filename, file_data: `./${imagesSubdir}/${filename}` } };
          } catch {
            // если не base64 — оставим как есть, обрезав
            return { type: 'file', file: { filename, file_data: `[stripped ${f.file_data.length} chars]` } };
          }
        }
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  }

  return walk(payload);
}
