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
  buildExtractParamsPromptBatch,
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
  /** Ширина пула параллельных батчей. Если не указано — берётся из config. */
  batchConcurrency?: number;
  /** Размер одного батча (сколько позиций идёт в один LLM-вызов). Если не указано — берётся из config. */
  batchSize?: number;
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
 * Извлекает параметры для пакета позиций ОДНИМ LLM-вызовом.
 *
 * Контракт надёжности: если модель вернула не все позиции / лишние / битый JSON —
 * для проблемных position выполняется fallback через одиночный extractSingleParameter.
 * Так батч никогда не валит весь блок — деградирует только проблемная строка.
 */
export async function extractParametersBatch(
  items: RawItemForExtraction[],
  opts: { comparisonId: string; side: ExtractSide; signal?: AbortSignal; dumpAggregator?: DumpAggregator; batchLabel?: string }
): Promise<{ items: ExtractedItem[]; ok: boolean[]; errors: (Error | undefined)[] }> {
  const expected = items.map((it) => it.position);
  const label = opts.batchLabel ?? `batch_${expected[0]}-${expected[expected.length - 1]}`;
  const startMs = Date.now();

  const fallbackAll = async (): Promise<{ items: ExtractedItem[]; ok: boolean[]; errors: (Error | undefined)[] }> => {
    const out: ExtractedItem[] = [];
    const okArr: boolean[] = [];
    const errArr: (Error | undefined)[] = [];
    for (const it of items) {
      const r = await extractSingleParameter(it, {
        comparisonId: opts.comparisonId,
        side: opts.side,
        signal: opts.signal,
        dumpName: String(it.position).padStart(3, '0'),
        dumpAggregator: opts.dumpAggregator,
      });
      out.push(r.item);
      okArr.push(r.ok);
      errArr.push(r.error);
    }
    return { items: out, ok: okArr, errors: errArr };
  };

  try {
    const { systemPrompt, userMessage } = buildExtractParamsPromptBatch(items);
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
      dumpContext: opts.dumpAggregator
        ? undefined
        : { comparisonId: opts.comparisonId, stage: `stage_a/${opts.side}`, name: label },
      dumpAggregator: opts.dumpAggregator,
      // Для агрегатора используем первую позицию как ключ — все айтемы батча всё равно
      // будут записаны через record(position, 'parsed', ...) ниже.
      dumpPosition: opts.dumpAggregator ? items[0]?.position : undefined,
    });

    const parsedArray = parseBatchResponse(llmResponse);
    if (!parsedArray) {
      console.warn(`[stage-a] ${opts.comparisonId} ${opts.side} ${label}: batch JSON invalid → fallback per-item`);
      return await fallbackAll();
    }

    // Индексируем по position
    const byPosition = new Map<number, unknown>();
    for (const raw of parsedArray) {
      if (raw && typeof raw === 'object' && typeof (raw as { position?: unknown }).position === 'number') {
        byPosition.set((raw as { position: number }).position, raw);
      }
    }

    // Sanity-check: ожидаемое количество и совпадение позиций
    const allPresent = expected.every((p) => byPosition.has(p));
    if (!allPresent || parsedArray.length !== expected.length) {
      console.warn(
        `[stage-a] ${opts.comparisonId} ${opts.side} ${label}: ожидалось ${expected.length} позиций, получено ${parsedArray.length}, missing=${expected.filter((p) => !byPosition.has(p)).join(',')} → fallback per-item для проблемных`
      );
    }

    const out: ExtractedItem[] = [];
    const okArr: boolean[] = [];
    const errArr: (Error | undefined)[] = [];

    for (const it of items) {
      const raw = byPosition.get(it.position);
      let normalized: ExtractedItem | null = null;
      if (raw) {
        try {
          normalized = normalizeExtractedItem(raw, it.position);
        } catch {
          normalized = null;
        }
      }
      if (!normalized) {
        // fallback на одиночный путь только для этой позиции
        const r = await extractSingleParameter(it, {
          comparisonId: opts.comparisonId,
          side: opts.side,
          signal: opts.signal,
          dumpName: String(it.position).padStart(3, '0'),
          dumpAggregator: opts.dumpAggregator,
        });
        out.push(r.item);
        okArr.push(r.ok);
        errArr.push(r.error);
      } else {
        if (opts.dumpAggregator) opts.dumpAggregator.record(it.position, 'parsed', normalized);
        out.push(normalized);
        okArr.push(true);
        errArr.push(undefined);
      }
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(
      `[stage-a] ${opts.comparisonId} ${opts.side} ${label}: ✓ batch ${items.length} items (${elapsed}s)`
    );
    return { items: out, ok: okArr, errors: errArr };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.warn(
      `[stage-a] ${opts.comparisonId} ${opts.side} ${label}: ✗ batch failed (${error.message}, ${elapsed}s) → fallback per-item`
    );
    return await fallbackAll();
  }
}

/**
 * Извлекает параметры для всего списка позиций.
 * Бьёт на батчи по EXTRACT_BATCH_SIZE и запускает их через пул шириной EXTRACT_BATCH_CONCURRENCY.
 * Внутри батча используется один LLM-вызов; при сбое — fallback через extractSingleParameter.
 * Колбэки onItemDone/onItemFailed вызываются по мере готовности каждой позиции, в порядке батчей.
 */
export async function extractParameters(
  items: RawItemForExtraction[],
  opts: ExtractParamsOptions
): Promise<ExtractedItem[]> {
  if (items.length === 0) return [];

  const batchSize = Math.max(1, opts.batchSize ?? config.EXTRACT_BATCH_SIZE);
  const poolWidth = Math.max(1, opts.batchConcurrency ?? config.EXTRACT_BATCH_CONCURRENCY);

  // Разбиваем на батчи
  const batches: RawItemForExtraction[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  console.log(
    `[stage-a] ${opts.comparisonId} ${opts.side}: ${items.length} позиций → ${batches.length} батчей × ${batchSize}, pool=${poolWidth}`
  );

  const results: (ExtractedItem | null)[] = new Array(items.length).fill(null);
  // Для сохранения порядка onItemDone используем пер-батчевые буферы и индексы.
  const batchStartIdx: number[] = [];
  {
    let acc = 0;
    for (const b of batches) {
      batchStartIdx.push(acc);
      acc += b.length;
    }
  }

  const startedAt = Date.now();
  const aggregator = createDumpAggregator(opts.comparisonId, `stage_a/${opts.side}`);

  // Очередь индексов батчей + пул воркеров
  let nextBatch = 0;
  let firstError: Error | null = null;

  const worker = async (): Promise<void> => {
    while (true) {
      if (firstError) return;
      if (opts.signal?.aborted) {
        firstError = new Error('Extraction aborted');
        return;
      }
      const myIdx = nextBatch++;
      if (myIdx >= batches.length) return;
      const batch = batches[myIdx]!;
      const label = `batch_${String(myIdx + 1).padStart(3, '0')}_of_${batches.length}`;
      try {
        const { items: outItems, ok, errors } = await extractParametersBatch(batch, {
          comparisonId: opts.comparisonId,
          side: opts.side,
          signal: opts.signal,
          dumpAggregator: aggregator,
          batchLabel: label,
        });
        // Запись результатов и колбэки — порядок внутри батча сохраняется.
        const start = batchStartIdx[myIdx]!;
        for (let j = 0; j < outItems.length; j++) {
          results[start + j] = outItems[j]!;
          if (ok[j]) {
            if (opts.onItemDone) await opts.onItemDone(outItems[j]!);
          } else if (opts.onItemFailed) {
            await opts.onItemFailed(outItems[j]!, errors[j] ?? new Error('unknown extract error'));
          }
        }
      } catch (err) {
        firstError = err instanceof Error ? err : new Error(String(err));
        return;
      }
    }
  };

  try {
    const workers = Array.from({ length: Math.min(poolWidth, batches.length) }, () => worker());
    await Promise.all(workers);
    if (firstError) throw firstError;
  } finally {
    aggregator.flush();
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const avg = (Number(elapsed) / items.length).toFixed(2);
  console.log(
    `[stage-a] ${opts.comparisonId} ${opts.side}: ✓ done (${items.length}/${items.length}, wall=${elapsed}s avg/item=${avg}s, batches=${batches.length}, pool=${poolWidth})`
  );

  return results.map((r, i) => r ?? makeFallback(items[i]!.position));
}

/** Парсит батч-ответ модели. Возвращает массив raw-объектов или null, если JSON битый. */
function parseBatchResponse(text: string): unknown[] | null {
  const cleaned = stripMarkdownFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as unknown[];
    // Толерантность: модель могла вернуть голый массив
    if (Array.isArray(parsed)) return parsed as unknown[];
  }
  if (Array.isArray(parsed)) return parsed as unknown[];
  return null;
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
  const categoryDef = findCategory(categoryRaw);
  const category = categoryDef.id;

  const shape = obj.shape;
  const normShape =
    shape === 'round' || shape === 'rectangular' || shape === 'square' ? shape : null;

  const item: ExtractedItem = {
    position,
    category,
    type: typeof obj.type === 'string' ? obj.type : null,
    shape: normShape,
    geometry: toRecord(obj.geometry),
    material: toRecord(obj.material),
    standards: toRecord(obj.standards),
    extra: toRecord(obj.extra),
  };

  // Канонизация неупорядоченных размерных групп категории.
  // Например: для прямоугольного воздуховода {B,H} → отсортированы по возрастанию,
  // чтобы 250×600 и 600×250 давали одинаковый снимок и не считались расхождением
  // ни в parameter-comparator, ни в fingerprint Fuse.
  // Для shapeMatters-категорий применяем только при rectangular (round/square не нуждаются).
  if (categoryDef.unorderedDims && categoryDef.unorderedDims.length >= 2) {
    if (!categoryDef.shapeMatters || normShape === 'rectangular') {
      canonicalizeUnorderedDims(item, categoryDef.unorderedDims);
    }
  }

  return item;
}

/**
 * Сортирует значения параметров `codes` по возрастанию и записывает обратно
 * по тем же ключам в исходном порядке. Применимо только если все коды лежат
 * в одной группе ExtractedItem (geometry/material/standards/extra) и все
 * значения числовые. В противном случае — no-op.
 */
function canonicalizeUnorderedDims(item: ExtractedItem, codes: string[]): void {
  const groups: Array<Record<string, number | string | null>> = [
    item.geometry,
    item.material,
    item.standards,
    item.extra,
  ];

  // Найти группу, в которой лежат все коды и все значения — числа.
  let target: Record<string, number | string | null> | null = null;
  for (const g of groups) {
    if (!g) continue;
    const allNumeric = codes.every((c) => typeof g[c] === 'number');
    if (allNumeric) {
      target = g;
      break;
    }
  }
  if (!target) return;

  const values = codes.map((c) => target![c] as number).sort((a, b) => a - b);
  for (let i = 0; i < codes.length; i++) {
    target[codes[i]!] = values[i]!;
  }
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
