/**
 * Unit normalization utilities for display purposes.
 * Actual quantity conversion during comparison is handled by the LLM.
 */

const UNIT_MAP: ReadonlyArray<[RegExp, string]> = [
  // Linear meters
  [/^(м\.?п\.?|п\.?м\.?|пог\.?\s*м\.?|метр[а-я]*\s*погон[а-я]*)$/i, 'м.п.'],
  // Square meters
  [/^(м\.?\s*кв\.?|кв\.?\s*м\.?|м²|м2|метр[а-я]*\s*квадрат[а-я]*)$/i, 'м²'],
  // Cubic meters
  [/^(м\.?\s*куб\.?|куб\.?\s*м\.?|м³|м3|метр[а-я]*\s*кубич[а-я]*)$/i, 'м³'],
  // Pieces
  [/^(шт\.?|штук[а-я]*|штк\.?)$/i, 'шт'],
  // Kilograms
  [/^(кг\.?|килограмм[а-я]*)$/i, 'кг'],
  // Tons
  [/^(т\.?|тонн[а-я]*)$/i, 'т'],
  // Meters
  [/^(м\.?|метр[а-я]*)$/i, 'м'],
  // Liters
  [/^(л\.?|литр[а-я]*)$/i, 'л'],
  // Sets
  [/^(компл\.?|комплект[а-я]*)$/i, 'компл'],
  // Packs
  [/^(уп\.?|упаков[а-я]*)$/i, 'уп'],
  // Rolls
  [/^(рул\.?|рулон[а-я]*)$/i, 'рул'],
  // Pallets
  [/^(подд\.?|поддон[а-я]*)$/i, 'подд'],
  // 100 square meters (roofing)
  [/^(100\s*м²|100\s*м\.?\s*кв\.?)$/i, '100м²'],
];

/**
 * Normalizes a raw unit string to a canonical short form.
 * Returns the original string trimmed if no mapping is found.
 */
export function normalizeUnit(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  for (const [pattern, normalized] of UNIT_MAP) {
    if (pattern.test(trimmed)) {
      return normalized;
    }
  }

  return trimmed;
}

/**
 * Checks whether two unit strings refer to the same physical quantity
 * after normalization. This is a shallow check; the LLM handles
 * cross-unit conversions (e.g. kg <-> tons).
 */
export function unitsMatch(unitA: string, unitB: string): boolean {
  return normalizeUnit(unitA) === normalizeUnit(unitB);
}

/**
 * Attempts to convert `qty` from `fromUnit` to `toUnit` using deterministic
 * rules (kg↔t, м²↔100м²). Returns null if units are incompatible.
 * Same unit — returns qty unchanged.
 */
export function convertQty(qty: number, fromUnit: string, toUnit: string): number | null {
  const a = normalizeUnit(fromUnit);
  const b = normalizeUnit(toUnit);
  if (a === b) return qty;
  if (a === 'кг' && b === 'т') return qty / 1000;
  if (a === 'т' && b === 'кг') return qty * 1000;
  if (a === 'м²' && b === '100м²') return qty / 100;
  if (a === '100м²' && b === 'м²') return qty * 100;
  return null;
}

export type QuantityStatus = 'exact' | 'within_tolerance' | 'over' | 'under' | 'incompatible_units';

export interface QuantityComparison {
  status: QuantityStatus;
  diffPct: number | null;
  convertedInvoiceQty: number | null;
  note: string | null;
}

/**
 * Compares an order quantity vs. (already-summed) invoice quantity,
 * converting units if needed. Returns a status and percent difference.
 */
export function compareQuantities(
  orderQty: number,
  orderUnit: string,
  invoiceQty: number,
  invoiceUnit: string
): QuantityComparison {
  const converted = convertQty(invoiceQty, invoiceUnit, orderUnit);
  if (converted == null) {
    return { status: 'incompatible_units', diffPct: null, convertedInvoiceQty: null, note: `Несовместимые единицы: ${invoiceUnit} → ${orderUnit}` };
  }
  if (orderQty <= 0) {
    return { status: 'exact', diffPct: 0, convertedInvoiceQty: converted, note: null };
  }
  const diffPct = Math.abs(orderQty - converted) / orderQty * 100;
  const rounded = Math.round(diffPct * 100) / 100;
  const note = normalizeUnit(invoiceUnit) !== normalizeUnit(orderUnit)
    ? `${invoiceQty} ${invoiceUnit} = ${converted} ${orderUnit}`
    : null;
  if (diffPct === 0) return { status: 'exact', diffPct: 0, convertedInvoiceQty: converted, note };
  if (diffPct <= 5) return { status: 'within_tolerance', diffPct: rounded, convertedInvoiceQty: converted, note };
  if (converted > orderQty) return { status: 'over', diffPct: rounded, convertedInvoiceQty: converted, note };
  return { status: 'under', diffPct: rounded, convertedInvoiceQty: converted, note };
}
