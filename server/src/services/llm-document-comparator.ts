/**
 * Stage B (LLM-метод): один LLM-вызов на два документа целиком.
 *
 * Получает оба полных списка ExtractedItem, отправляет их одним запросом,
 * парсит JSON, валидирует уникальность invoicePosition и прогоняет каждый
 * матч через детерминированный compareItems для пост-валидации.
 */

import { config } from '../config.js';
import { callOpenRouter } from './llm.js';
import {
  buildCompareDocumentsPrompt,
  parseCompareDocumentsResponse,
  type DocumentMatch,
  type DocumentSplitEntry,
} from '../prompts/compare-documents.js';
import type { ExtractedItem } from '../prompts/extract-params.js';
import { compareItems, type CompareDecision } from './parameter-comparator.js';
import { dumpParsed, dumpJson, type DumpContext } from '../utils/llm-dump.js';

export interface MatchPair {
  orderPosition: number;
  invoicePosition: number | null;
  /** Для разбиения 1→N: все позиции счёта, связанные с этой позицией заказа. */
  invoicePositions?: number[];
  /** Разбивка по подсистемам из комментария к заказу. */
  splitByGroup?: DocumentSplitEntry[];
  confidence: number;
  reasoning: string;
  /** Решение детерминированного валидатора, если матч есть. */
  decision?: CompareDecision;
}

export interface MatchLlmOptions {
  comparisonId: string;
  signal?: AbortSignal;
  userPrompt?: string | null;
  orderComments?: Map<number, string>;
}

export async function matchLlm(
  orderItems: ExtractedItem[],
  invoiceItems: ExtractedItem[],
  opts: MatchLlmOptions
): Promise<MatchPair[]> {
  const { systemPrompt, userMessage } = buildCompareDocumentsPrompt(orderItems, invoiceItems, {
    userPrompt: opts.userPrompt,
    orderComments: opts.orderComments,
  });

  const dumpCtx: DumpContext = {
    comparisonId: opts.comparisonId,
    stage: 'stage_b/llm',
    name: '001',
  };

  console.log(
    `[stage-b:llm] ${opts.comparisonId} single call: prompt ~${Math.round((systemPrompt.length + userMessage.length) / 1024)} KB, model=${config.OPENROUTER_MODEL_COMPARE}`
  );
  const startMs = Date.now();

  const response = await callOpenRouter({
    model: config.OPENROUTER_MODEL_COMPARE,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.1,
    responseFormat: { type: 'json_object' },
    signal: opts.signal,
    timeoutMs: config.LLM_CALL_TIMEOUT_MS,
    dumpContext: dumpCtx,
  });

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const parsed = parseCompareDocumentsResponse(response);
  dumpParsed(dumpCtx, parsed);

  console.log(
    `[stage-b:llm] ${opts.comparisonId} ← response (${elapsed}s) — ${parsed.matches.length} matches in raw response`
  );

  // Уникальность позиций счёта: каждая invoicePosition может использоваться в одной
  // orderPosition. Для 1→N берём invoicePositions[] как источник истины.
  // Если одна позиция счёта всплывает в двух разных orderPosition — оставляем первое.
  const usedInvoice = new Set<number>();
  const dedup: DocumentMatch[] = [];
  for (const m of parsed.matches) {
    const positions = Array.isArray(m.invoicePositions) && m.invoicePositions.length > 0
      ? m.invoicePositions.filter((p): p is number => typeof p === 'number')
      : (m.invoicePosition != null ? [m.invoicePosition] : []);

    if (positions.length === 0) {
      dedup.push({ ...m, invoicePosition: null });
      continue;
    }

    const kept: number[] = [];
    const dropped: number[] = [];
    for (const p of positions) {
      if (usedInvoice.has(p)) dropped.push(p);
      else { kept.push(p); usedInvoice.add(p); }
    }

    if (kept.length === 0) {
      console.warn(
        `[stage-b:llm] ${opts.comparisonId} все позиции счёта дубликаты для order#${m.orderPosition} — unmatched`
      );
      dedup.push({ ...m, invoicePosition: null, invoicePositions: undefined, splitByGroup: undefined, confidence: 0, reasoning: `${m.reasoning} (дубликат счёта)` });
      continue;
    }

    if (dropped.length > 0) {
      console.warn(
        `[stage-b:llm] ${opts.comparisonId} order#${m.orderPosition}: отброшены дубликаты счёта ${dropped.join(',')}`
      );
    }

    const filteredSplit = Array.isArray(m.splitByGroup)
      ? m.splitByGroup.filter((s) => kept.includes(s.invoicePosition))
      : undefined;

    dedup.push({
      ...m,
      invoicePosition: kept[0]!,
      invoicePositions: kept.length > 1 ? kept : undefined,
      splitByGroup: filteredSplit && filteredSplit.length > 0 ? filteredSplit : undefined,
    });
  }

  // Гарантия: для каждой orderPosition есть запись (если LLM что-то пропустила).
  const orderById = new Map(orderItems.map((it) => [it.position, it]));
  const seen = new Set(dedup.map((m) => m.orderPosition));
  for (const it of orderItems) {
    if (!seen.has(it.position)) {
      dedup.push({
        orderPosition: it.position,
        invoicePosition: null,
        confidence: 0,
        reasoning: 'LLM не вернула эту позицию',
      });
    }
  }

  // Пост-валидация: каждый матч через compareItems.
  const orderByPos = orderById;
  const invoiceByPos = new Map(invoiceItems.map((it) => [it.position, it]));

  const validated: MatchPair[] = dedup.map((m) => {
    if (m.invoicePosition == null) {
      return {
        orderPosition: m.orderPosition,
        invoicePosition: null,
        confidence: m.confidence,
        reasoning: m.reasoning,
      };
    }
    const order = orderByPos.get(m.orderPosition);
    const invoice = invoiceByPos.get(m.invoicePosition);
    if (!order || !invoice) {
      return {
        orderPosition: m.orderPosition,
        invoicePosition: m.invoicePosition,
        invoicePositions: m.invoicePositions,
        splitByGroup: m.splitByGroup,
        confidence: m.confidence,
        reasoning: m.reasoning,
      };
    }
    const decision = compareItems(order, invoice);
    return {
      orderPosition: m.orderPosition,
      invoicePosition: m.invoicePosition,
      invoicePositions: m.invoicePositions,
      splitByGroup: m.splitByGroup,
      confidence: decision.confidence,
      reasoning: m.reasoning,
      decision,
    };
  });

  dumpJson(opts.comparisonId, 'stage_b/llm/001_validated.json', validated);

  const matchedCount = validated.filter((m) => m.invoicePosition != null).length;
  console.log(
    `[stage-b:llm] ${opts.comparisonId} post-validation: matched ${matchedCount}, unmatched ${validated.length - matchedCount}`
  );

  return validated;
}
