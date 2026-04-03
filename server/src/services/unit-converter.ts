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
