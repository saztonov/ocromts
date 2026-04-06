/**
 * Stage A: вызов LLM для извлечения структурированных параметров материалов.
 *
 * Принимает «сырые» позиции (имя + ед.изм. + количество), батчирует их,
 * вызывает callOpenRouter и возвращает массив ExtractedItem с категорией
 * и группами параметров (geometry/material/standards/extra).
 *
 * Stage B (parameter-comparator) использует результат для детерминированного
 * сопоставления и классификации расхождений.
 */

import { config } from '../config.js';
import { callOpenRouter } from './llm.js';
import {
  buildExtractParamsPrompt,
  type ExtractedItem,
  type ExtractResult,
  type RawItemForExtraction,
} from '../prompts/extract-params.js';
import { findCategory } from '../data/material-categories.js';

const EXTRACT_BATCH_SIZE = 30;

/**
 * Извлекает структурированные параметры для всего списка позиций.
 * Обрабатывает позиции батчами по EXTRACT_BATCH_SIZE и объединяет результаты.
 */
export async function extractParameters(
  items: RawItemForExtraction[],
  signal?: AbortSignal,
  label = 'items'
): Promise<ExtractedItem[]> {
  if (items.length === 0) return [];

  const batches: RawItemForExtraction[][] = [];
  for (let i = 0; i < items.length; i += EXTRACT_BATCH_SIZE) {
    batches.push(items.slice(i, i + EXTRACT_BATCH_SIZE));
  }

  console.log(
    `[extract] ${label}: ${items.length} позиций → ${batches.length} батч(ей) по ${EXTRACT_BATCH_SIZE}`
  );

  const merged: ExtractedItem[] = [];
  const seenPositions = new Set<number>();

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]!;
    const { systemPrompt, userMessage } = buildExtractParamsPrompt(batch);

    console.log(`[extract] ${label}: батч ${batchIdx + 1}/${batches.length} (${batch.length} позиций)`);

    const llmResponse = await callOpenRouter({
      model: config.OPENROUTER_MODEL_EXTRACT,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.1,
      responseFormat: { type: 'json_object' },
      signal,
    });

    const parsed = parseExtractResponse(llmResponse);

    for (const it of parsed.items ?? []) {
      const normalized = normalizeExtractedItem(it);
      if (normalized && !seenPositions.has(normalized.position)) {
        merged.push(normalized);
        seenPositions.add(normalized.position);
      }
    }
  }

  // Для позиций, которые модель «потеряла», создаём fallback-запись с категорией `other`.
  for (const it of items) {
    if (!seenPositions.has(it.position)) {
      console.warn(`[extract] ${label}: модель не вернула параметры для позиции ${it.position} ("${it.rawName}") — fallback на 'other'`);
      merged.push({
        position: it.position,
        category: 'other',
        type: null,
        shape: null,
        geometry: {},
        material: {},
        standards: {},
        extra: {},
      });
    }
  }

  merged.sort((a, b) => a.position - b.position);
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────

/** Парсит ответ LLM (JSON, может быть в markdown-обёртке). */
function parseExtractResponse(text: string): ExtractResult {
  const cleaned = stripMarkdownFences(text);
  try {
    const parsed = JSON.parse(cleaned) as ExtractResult;
    if (!parsed.items || !Array.isArray(parsed.items)) {
      throw new Error('Поле items отсутствует или не массив');
    }
    return parsed;
  } catch (err) {
    console.error('[extract] Не удалось распарсить ответ LLM:', err);
    console.error('[extract] Ответ:', text.slice(0, 500));
    return { items: [] };
  }
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
 * Нормализует один ExtractedItem от LLM:
 *  - проверяет position и category
 *  - гарантирует наличие 4 групп параметров (даже если пустые)
 *  - подменяет неизвестную категорию на `other`
 */
function normalizeExtractedItem(raw: unknown): ExtractedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const position = typeof obj.position === 'number' ? obj.position : null;
  if (position == null) return null;

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
    // Игнорируем вложенные объекты/массивы — модель не должна их возвращать на этом этапе.
  }
  return out;
}
