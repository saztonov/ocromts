/**
 * Stage B: Детерминированное сопоставление структурированных параметров.
 *
 * Принимает два ExtractedItem (из заказа и из накладной) и возвращает решение:
 *  - является ли пара действительным совпадением (или должна быть отбракована)
 *  - список расхождений по параметрам, классифицированных по severity
 *  - выведенный статус: matched / partial / mismatch
 *  - итоговую confidence
 *
 * Логика проста и универсальна: проходим по keyParams[] категории
 * (из material-categories.ts) и сравниваем каждое значение с допуском.
 * Никакого хардкода под конкретные материалы.
 */

import {
  findCategory,
  type MaterialCategory,
  type ParamSpec,
  type Severity,
  type Tolerance,
} from '../data/material-categories.js';
import type { ExtractedItem } from '../prompts/extract-params.js';

export type DerivedMatchStatus = 'matched' | 'partial' | 'mismatch';

export interface DeterministicMismatch {
  parameter: string;       // label на русском
  parameter_code: string;  // машинный код
  group: string;
  order_value: string;
  invoice_value: string;
  severity: Severity;
}

export interface CompareDecision {
  /** false → пара отбракована (категория или критическая форма не совпали) */
  isMatch: boolean;
  /** Причина отбраковки, если isMatch=false */
  rejectReason?: string;
  /** Все различающиеся параметры по правилам категории */
  mismatches: DeterministicMismatch[];
  /** Итоговый статус для сохранения в БД */
  derivedStatus: DerivedMatchStatus;
  /** Численная уверенность 0..1 */
  confidence: number;
  /** Категория, по которой производилось сравнение */
  category: string;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Сопоставляет две структурированные позиции.
 *
 * @param order   Параметры из заказа
 * @param invoice Параметры из накладной
 */
export function compareItems(
  order: ExtractedItem,
  invoice: ExtractedItem
): CompareDecision {
  // 1. Категория должна совпадать. Если LLM поставил разные категории —
  //    позиции точно не одно и то же.
  if (order.category !== invoice.category) {
    return {
      isMatch: false,
      rejectReason: `Разные категории: ${order.category} ≠ ${invoice.category}`,
      mismatches: [],
      derivedStatus: 'mismatch',
      confidence: 0,
      category: order.category,
    };
  }

  const category = findCategory(order.category);

  // 2. Если для категории форма критична — она должна совпадать.
  //    Например: круглый воздуховод ≠ прямоугольный воздуховод.
  if (category.shapeMatters && order.shape && invoice.shape && order.shape !== invoice.shape) {
    return {
      isMatch: false,
      rejectReason: `Разная форма сечения: ${order.shape} ≠ ${invoice.shape}`,
      mismatches: [],
      derivedStatus: 'mismatch',
      confidence: 0,
      category: category.id,
    };
  }

  // 3. Идём по keyParams и собираем все реальные расхождения.
  const mismatches: DeterministicMismatch[] = [];

  for (const spec of category.keyParams) {
    const orderVal = pickParam(order, spec.code);
    const invoiceVal = pickParam(invoice, spec.code);

    // Если параметр отсутствует в обоих — пропускаем.
    if (orderVal == null && invoiceVal == null) continue;

    // Если в одном есть, в другом нет — это расхождение по этому параметру.
    if (orderVal == null || invoiceVal == null) {
      mismatches.push({
        parameter: spec.label,
        parameter_code: spec.code,
        group: spec.group,
        order_value: orderVal != null ? formatVal(orderVal, spec.unit) : '—',
        invoice_value: invoiceVal != null ? formatVal(invoiceVal, spec.unit) : '—',
        severity: downgradeMissing(spec.severity),
      });
      continue;
    }

    // Оба значения присутствуют — сравниваем по правилу tolerance.
    if (!valuesEqual(orderVal, invoiceVal, spec.tolerance)) {
      mismatches.push({
        parameter: spec.label,
        parameter_code: spec.code,
        group: spec.group,
        order_value: formatVal(orderVal, spec.unit),
        invoice_value: formatVal(invoiceVal, spec.unit),
        severity: spec.severity,
      });
    }
  }

  // 4. Доп. проверка: если в категории `other` (LLM не смог классифицировать)
  //    и нет ни одного общего параметра — confidence низкая, но isMatch остаётся true,
  //    т.к. LLM посчитал их одной парой по тексту.
  const criticalCount = mismatches.filter((m) => m.severity === 'critical').length;
  const warningCount = mismatches.filter((m) => m.severity === 'warning').length;

  let derivedStatus: DerivedMatchStatus;
  let confidence: number;

  if (criticalCount > 0) {
    derivedStatus = 'mismatch';
    confidence = 0.3;
  } else if (warningCount > 0) {
    derivedStatus = 'partial';
    confidence = 0.7;
  } else {
    derivedStatus = 'matched';
    confidence = mismatches.length === 0 ? 1.0 : 0.95;
  }

  return {
    isMatch: true,
    mismatches,
    derivedStatus,
    confidence,
    category: category.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers

/** Извлекает значение параметра по коду из любой группы ExtractedItem. */
function pickParam(item: ExtractedItem, code: string): number | string | null {
  const groups: Array<Record<string, number | string | null>> = [
    item.geometry,
    item.material,
    item.standards,
    item.extra,
  ];
  for (const g of groups) {
    if (g && Object.prototype.hasOwnProperty.call(g, code)) {
      const v = g[code];
      if (v !== null && v !== undefined && v !== '') return v;
    }
  }
  return null;
}

/** Сравнивает два значения с учётом правила допуска. */
function valuesEqual(
  a: number | string,
  b: number | string,
  tolerance: Tolerance
): boolean {
  // Числовое сравнение
  const numA = toNumber(a);
  const numB = toNumber(b);
  if (numA != null && numB != null) {
    if (tolerance.type === 'exact') return numA === numB;
    if (tolerance.type === 'abs') return Math.abs(numA - numB) <= tolerance.value;
    if (tolerance.type === 'pct') {
      const base = Math.max(Math.abs(numA), Math.abs(numB));
      if (base === 0) return true;
      return (Math.abs(numA - numB) / base) * 100 <= tolerance.value;
    }
  }

  // Строковое сравнение — нормализуем
  const strA = normalizeStr(String(a));
  const strB = normalizeStr(String(b));
  return strA === strB;
}

function toNumber(v: number | string): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // Поддержка "1,5" и "1.5"
  const cleaned = v.trim().replace(',', '.').replace(/[^\d.\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeStr(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\s\-_/.,]/g, '')
    .trim();
}

function formatVal(v: number | string, unit?: string): string {
  const base = typeof v === 'number' ? String(v) : v;
  return unit ? `${base} ${unit}` : base;
}

/**
 * Если параметр заявлен как critical, но в одной из позиций отсутствует
 * (а в другой есть), это менее серьёзно чем «значения различаются».
 * Понижаем тяжесть на одну ступень: critical→warning, warning→info.
 */
function downgradeMissing(sev: Severity): Severity {
  if (sev === 'critical') return 'warning';
  if (sev === 'warning') return 'info';
  return sev;
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-export для удобства
export type { ExtractedItem, MaterialCategory, ParamSpec };
