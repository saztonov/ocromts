/**
 * Stage A: построчное извлечение структурированных параметров материалов.
 *
 * На каждую позицию делается отдельный LLM-вызов. Это даёт:
 *  - предсказуемость (один батч ↔ одна строка ↔ один JSON)
 *  - возможность писать результат в БД сразу после ответа модели
 *  - устойчивость к сбоям одиночных вызовов: если 17-я позиция упала, 1–16 уже сохранены
 *
 * Вызывающий код передаёт onItemDone, чтобы немедленно персистить позицию в БД.
 */

import { config } from '../config.js';
import { callOpenRouter } from './llm.js';
import {
  buildExtractParamsPromptSingle,
  type ExtractedItem,
  type RawItemForExtraction,
} from '../prompts/extract-params.js';
import { findCategory } from '../data/material-categories.js';
import { dumpParsed, createDumpAggregator, type DumpContext, type DumpAggregator } from '../utils/llm-dump.js';

export type ExtractSide = 'order' | 'invoice';

export interface ExtractParamsOptions {
  comparisonId: string;
  side: ExtractSide;
  signal?: AbortSignal;
  /** Колбэк после успешной обработки одной позиции (для немедленной записи в БД). */
  onItemDone?: (item: ExtractedItem) => void | Promise<void>;
  /** Колбэк после неудачной обработки (после всех ретраев). Приходит fallback-объект. */
  onItemFailed?: (item: ExtractedItem, error: Error) => void | Promise<void>;
}

/**
 * Извлекает параметры для одной позиции через LLM.
 * Обрабатывает ошибки парсинга/нормализации, при сбое возвращает fallback (`category: 'other'`).
 *
 * Используется как из основного цикла extractParameters, так и из retry-эндпоинта.
 */
export async function extractSingleParameter(
  item: RawItemForExtraction,
  opts: { comparisonId: string; side: ExtractSide; signal?: AbortSignal; dumpName?: string; dumpAggregator?: DumpAggregator }
): Promise<{ item: ExtractedItem; ok: boolean; error?: Error }> {
  const { systemPrompt, userMessage } = buildExtractParamsPromptSingle(item);
  const dumpName = opts.dumpName ?? `${String(item.position).padStart(3, '0')}_${item.position}`;
  const useAggregator = !!opts.dumpAggregator;
  const dumpCtx: DumpContext | undefined = useAggregator
    ? undefined
    : {
        comparisonId: opts.comparisonId,
        stage: `stage_a/${opts.side}`,
        name: dumpName,
      };

  const startMs = Date.now();
  try {
    const llmResponse = await callOpenRouter({
      model: config.OPENROUTER_MODEL_EXTRACT,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.1,
      responseFormat: { type: 'json_object' },
      signal: opts.signal,
      timeoutMs: config.LLM_EXTRACT_TIMEOUT_MS,
      dumpContext: dumpCtx,
      dumpAggregator: opts.dumpAggregator,
      dumpPosition: useAggregator ? item.position : undefined,
    });

    const parsed = parseSingleResponse(llmResponse, item.position);
    const normalized = normalizeExtractedItem(parsed, item.position);
    if (!normalized) {
      throw new Error('Не удалось нормализовать ответ LLM');
    }
    if (opts.dumpAggregator) opts.dumpAggregator.record(item.position, 'parsed', normalized);
    else if (dumpCtx) dumpParsed(dumpCtx, normalized);
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(
      `[stage-a] ${opts.comparisonId} ${opts.side} ${item.position}: "${truncate(item.rawName, 60)}" → ${normalized.category}/${normalized.shape ?? '-'} (${elapsed}s)`
    );
    return { item: normalized, ok: true };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.warn(
      `[stage-a] ${opts.comparisonId} ${opts.side} ${item.position}: ✗ ${error.message} (${elapsed}s) — fallback на 'other'`
    );
    const fallback = makeFallback(item.position);
    if (opts.dumpAggregator) opts.dumpAggregator.record(item.position, 'parsed', { ...fallback, _error: error.message });
    else if (dumpCtx) dumpParsed(dumpCtx, { ...fallback, _error: error.message });
    return { item: fallback, ok: false, error };
  }
}

/**
 * Извлекает параметры для всего списка позиций.
 * Обрабатывает строго последовательно: жди ответ → парсь JSON → onItemDone → следующая.
 */
export async function extractParameters(
  items: RawItemForExtraction[],
  opts: ExtractParamsOptions
): Promise<ExtractedItem[]> {
  if (items.length === 0) return [];

  console.log(
    `[stage-a] ${opts.comparisonId} ${opts.side}: ${items.length} позиций → построчная обработка`
  );

  const results: ExtractedItem[] = [];
  const startedAt = Date.now();
  const aggregator = createDumpAggregator(opts.comparisonId, `stage_a/${opts.side}`);

  try {
    for (let i = 0; i < items.length; i++) {
      if (opts.signal?.aborted) {
        throw new Error('Extraction aborted');
      }
      const it = items[i]!;
      console.log(`[stage-a] ${opts.comparisonId} ${opts.side} ${i + 1}/${items.length}: → ${truncate(it.rawName, 80)}`);

      const { item: extracted, ok, error } = await extractSingleParameter(it, {
        comparisonId: opts.comparisonId,
        side: opts.side,
        signal: opts.signal,
        dumpName: String(it.position).padStart(3, '0'),
        dumpAggregator: aggregator,
      });

      results.push(extracted);
      if (ok) {
        if (opts.onItemDone) await opts.onItemDone(extracted);
      } else {
        if (opts.onItemFailed) await opts.onItemFailed(extracted, error!);
      }
    }
  } finally {
    aggregator.flush();
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const avg = (Number(elapsed) / items.length).toFixed(2);
  console.log(
    `[stage-a] ${opts.comparisonId} ${opts.side}: ✓ done (${results.length}/${items.length}, ${elapsed}s avg=${avg}s)`
  );

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────

function makeFallback(position: number): ExtractedItem {
  return {
    position,
    category: 'other',
    type: null,
    shape: null,
    geometry: {},
    material: {},
    standards: {},
    extra: {},
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * Парсит ответ LLM. Ожидает один объект (без обёртки items[]),
 * но толерантен к старому формату { items: [{...}] } на случай если модель завернёт.
 */
function parseSingleResponse(text: string, expectedPosition: number): unknown {
  const cleaned = stripMarkdownFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    // Толерантность к items[]: возьмём первый элемент с нужной position или просто первый.
    if (Array.isArray(obj.items)) {
      const arr = obj.items as Array<Record<string, unknown>>;
      const match = arr.find((x) => x?.position === expectedPosition) ?? arr[0];
      return match ?? obj;
    }
  }
  return parsed;
}

function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();
  const closedFence = cleaned.match(/^```(?:json)?\s*\n([\s\S]*)\n\s*```\s*$/);
  if (closedFence) cleaned = closedFence[1]!.trim();
  else {
    const openFence = cleaned.match(/^```(?:json)?\s*\n([\s\S]*)$/);
    if (openFence) cleaned = openFence[1]!.trim();
  }
  return cleaned;
}

/**
 * Нормализует один ExtractedItem от LLM.
 * Если position в ответе отсутствует или иной — подставляем ожидаемый.
 */
function normalizeExtractedItem(raw: unknown, expectedPosition: number): ExtractedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const position = typeof obj.position === 'number' ? obj.position : expectedPosition;

  const categoryRaw = typeof obj.category === 'string' ? obj.category : 'other';
  const category = findCategory(categoryRaw).id;

  const shape = obj.shape;
  const normShape =
    shape === 'round' || shape === 'rectangular' || shape === 'square' ? shape : null;

  return {
    position,
    category,
    type: typeof obj.type === 'string' ? obj.type : null,
    shape: normShape,
    geometry: toRecord(obj.geometry),
    material: toRecord(obj.material),
    standards: toRecord(obj.standards),
    extra: toRecord(obj.extra),
  };
}

function toRecord(value: unknown): Record<string, number | string | null> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number | string | null> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || typeof v === 'number' || typeof v === 'string') {
      out[k] = v;
    } else if (typeof v === 'boolean') {
      out[k] = v ? 'да' : 'нет';
    }
  }
  return out;
}
