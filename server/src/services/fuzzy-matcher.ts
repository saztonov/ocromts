/**
 * Stage B (Fuzzy-метод): нестрогий поиск кандидатов через Fuse.js
 * + детерминированная валидация через parameter-comparator.
 *
 * Для каждой позиции заказа Fuse возвращает top-N кандидатов из счёта,
 * затем каждого пропускаем через compareItems и выбираем лучшего по
 * derivedStatus + confidence. Жадный матчинг: один invoice = один order.
 */

import Fuse from 'fuse.js';
import type { ExtractedItem } from '../prompts/extract-params.js';
import { compareItems, type CompareDecision } from './parameter-comparator.js';
import { findCategory } from '../data/material-categories.js';
import { dumpJson } from '../utils/llm-dump.js';
import type { MatchPair } from './llm-document-comparator.js';

interface InvoiceFingerprint {
  position: number;
  fp: string;
  item: ExtractedItem;
}

const TOP_K = 5;
const FUSE_THRESHOLD = 0.5;
/** Минимальная confidence детерминированного валидатора, ниже — пара не записывается. */
const FUZZY_MIN_CONFIDENCE = 0.5;
/** Порог «надёжного» матча для первого прохода жадного матчинга. */
const FUZZY_STRONG_CONFIDENCE = 0.9;

export interface MatchFuzzyOptions {
  comparisonId: string;
}

export function matchFuzzy(
  orderItems: ExtractedItem[],
  invoiceItems: ExtractedItem[],
  opts: MatchFuzzyOptions
): MatchPair[] {
  console.log(
    `[stage-b:fuzzy] ${opts.comparisonId} indexing ${invoiceItems.length} invoice items`
  );

  const startMs = Date.now();

  const invoiceFingerprints: InvoiceFingerprint[] = invoiceItems.map((it) => ({
    position: it.position,
    fp: fingerprint(it),
    item: it,
  }));

  const fuse = new Fuse(invoiceFingerprints, {
    keys: ['fp'],
    threshold: FUSE_THRESHOLD,
    includeScore: true,
    ignoreLocation: true,
  });

  const candidatesDump: Array<{
    orderPosition: number;
    orderFp: string;
    candidates: Array<{ position: number; score: number; fp: string }>;
  }> = [];

  // Предварительный шаг: для каждой позиции заказа собираем top-K кандидатов
  // и считаем для них детерминированный compareItems. Это позволяет затем
  // сделать двухпроходный жадный матчинг (сначала «надёжные», потом остальные).
  type Scored = {
    order: ExtractedItem;
    candidates: Array<{
      invoice: ExtractedItem;
      decision: CompareDecision;
      fuseScore: number;
    }>;
  };

  const scored: Scored[] = orderItems.map((order) => {
    const orderFp = fingerprint(order);
    const found = fuse.search(orderFp, { limit: TOP_K });

    candidatesDump.push({
      orderPosition: order.position,
      orderFp,
      candidates: found.map((f) => ({ position: f.item.position, score: f.score ?? 0, fp: f.item.fp })),
    });

    const cands = found
      .map((f) => {
        const decision = compareItems(order, f.item.item);
        return { invoice: f.item.item, decision, fuseScore: f.score ?? 1 };
      })
      // Отбрасываем абсолютно несовместимые (разная категория / форма).
      .filter((c) => c.decision.isMatch)
      // Стабильное упорядочивание: confidence ↓, затем fuse_score ↑ (лучший — меньше).
      .sort((a, b) => {
        if (b.decision.confidence !== a.decision.confidence) {
          return b.decision.confidence - a.decision.confidence;
        }
        return a.fuseScore - b.fuseScore;
      });

    return { order, candidates: cands };
  });

  const usedInvoice = new Set<number>();
  const matchedOrder = new Map<number, { invoice: ExtractedItem; decision: CompareDecision; fuseScore: number }>();

  /** Один проход жадного матчинга по списку позиций с указанным порогом. */
  const greedyPass = (minConfidence: number) => {
    for (const s of scored) {
      if (matchedOrder.has(s.order.position)) continue;
      for (const cand of s.candidates) {
        if (cand.decision.confidence < minConfidence) break; // отсортировано по confidence ↓
        if (usedInvoice.has(cand.invoice.position)) continue;
        usedInvoice.add(cand.invoice.position);
        matchedOrder.set(s.order.position, cand);
        break;
      }
    }
  };

  // Проход 1: только надёжные пары — это снимает ситуацию, когда «слабая»
  // пара заказа #N перехватывает invoice, который должен был достаться
  // «надёжной» паре заказа #M.
  greedyPass(FUZZY_STRONG_CONFIDENCE);
  // Проход 2: добиваем оставшиеся по нижнему порогу.
  greedyPass(FUZZY_MIN_CONFIDENCE);

  const results: MatchPair[] = orderItems.map((order) => {
    const best = matchedOrder.get(order.position);
    if (best) {
      return {
        orderPosition: order.position,
        invoicePosition: best.invoice.position,
        confidence: best.decision.confidence,
        reasoning: `fuzzy: top-${TOP_K}, fuse_score=${best.fuseScore.toFixed(2)}`,
        decision: best.decision,
      };
    }
    const s = scored.find((x) => x.order.position === order.position);
    const reason =
      !s || s.candidates.length === 0
        ? 'fuzzy: нет кандидатов'
        : `fuzzy: ни один кандидат не прошёл порог confidence≥${FUZZY_MIN_CONFIDENCE}`;
    return {
      orderPosition: order.position,
      invoicePosition: null,
      confidence: 0,
      reasoning: reason,
    };
  });

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const matched = results.filter((r) => r.invoicePosition != null).length;

  console.log(
    `[stage-b:fuzzy] ${opts.comparisonId} ✓ done — matched ${matched}, unmatched ${results.length - matched} (${elapsed}s)`
  );

  dumpJson(opts.comparisonId, 'stage_b/fuzzy/candidates.json', candidatesDump);
  dumpJson(opts.comparisonId, 'stage_b/fuzzy/result.json', results);

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Собирает строку-«отпечаток» для Fuse: категория, форма, тип и значения
 * только тех параметров, которые объявлены keyParams для категории.
 * Это убирает шум полей extra (которые часто присутствуют только на одной
 * стороне, например `flange`/`area_m2` у воздуховодов) и резко повышает
 * fuse-score правильных пар.
 */
function fingerprint(item: ExtractedItem): string {
  const parts: string[] = [item.category];
  if (item.shape) parts.push(item.shape);
  if (item.type) parts.push(item.type);

  const cat = findCategory(item.category);
  const groups: Record<string, Record<string, number | string | null> | undefined> = {
    geometry: item.geometry,
    material: item.material,
    standards: item.standards,
    extra: item.extra,
  };

  for (const spec of cat.keyParams) {
    const g = groups[spec.group];
    if (!g) continue;
    const v = g[spec.code];
    if (v === null || v === undefined || v === '') continue;
    parts.push(`${spec.code}=${v}`);
  }

  return parts.join(' ');
}
