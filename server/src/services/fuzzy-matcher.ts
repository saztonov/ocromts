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
import { dumpJson } from '../utils/llm-dump.js';
import type { MatchPair } from './llm-document-comparator.js';

interface InvoiceFingerprint {
  position: number;
  fp: string;
  item: ExtractedItem;
}

const TOP_K = 5;
const FUSE_THRESHOLD = 0.5;

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

  const usedInvoice = new Set<number>();
  const results: MatchPair[] = [];

  for (const order of orderItems) {
    const orderFp = fingerprint(order);
    const found = fuse.search(orderFp, { limit: TOP_K });

    candidatesDump.push({
      orderPosition: order.position,
      orderFp,
      candidates: found.map((f) => ({ position: f.item.position, score: f.score ?? 0, fp: f.item.fp })),
    });

    // Прогоняем кандидатов через детерминированный compareItems, выбираем лучшего.
    let best: { invoice: ExtractedItem; decision: CompareDecision; fuseScore: number } | null = null;
    for (const cand of found) {
      if (usedInvoice.has(cand.item.position)) continue;
      const decision = compareItems(order, cand.item.item);
      if (!decision.isMatch) continue;
      if (best == null || decision.confidence > best.decision.confidence) {
        best = { invoice: cand.item.item, decision, fuseScore: cand.score ?? 1 };
      }
    }

    if (best) {
      usedInvoice.add(best.invoice.position);
      results.push({
        orderPosition: order.position,
        invoicePosition: best.invoice.position,
        confidence: best.decision.confidence,
        reasoning: `fuzzy: top-${TOP_K}, fuse_score=${best.fuseScore.toFixed(2)}`,
        decision: best.decision,
      });
    } else {
      results.push({
        orderPosition: order.position,
        invoicePosition: null,
        confidence: 0,
        reasoning: found.length === 0 ? 'fuzzy: нет кандидатов' : 'fuzzy: ни один кандидат не прошёл валидацию',
      });
    }
  }

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
 * Собирает строку-«отпечаток» для Fuse: категория, форма, тип и все непустые
 * параметры из всех групп. Это даёт хороший recall на похожих позициях.
 */
function fingerprint(item: ExtractedItem): string {
  const parts: string[] = [item.category];
  if (item.shape) parts.push(item.shape);
  if (item.type) parts.push(item.type);

  for (const g of [item.geometry, item.material, item.standards, item.extra]) {
    if (!g) continue;
    for (const [k, v] of Object.entries(g)) {
      if (v === null || v === undefined || v === '') continue;
      parts.push(`${k}=${v}`);
    }
  }

  return parts.join(' ');
}
