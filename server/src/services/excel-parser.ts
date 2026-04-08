import XLSX from 'xlsx';
import { normalizeUnit } from './unit-converter.js';

export interface ParsedItem {
  position: number;
  rawName: string;
  unit: string;
  quantity: number;
  unitPrice?: number;
  totalPrice?: number;
  comment?: string | null;
  commentHasUnits?: boolean;
}

/** Keyword groups for header detection (all lowercase). */
const NAME_KEYWORDS = ['наименование', 'название', 'материал', 'товар', 'описание', 'номенклатура'];
const UNIT_KEYWORDS = ['ед', 'ед.изм', 'единица', 'изм', 'ед. изм.', 'единица измерения'];
const QTY_KEYWORDS = ['кол-во', 'количество', 'объём', 'объем', 'кол.', 'кол', 'к-во'];
const PRICE_KEYWORDS = ['цена', 'цена за ед'];
const TOTAL_KEYWORDS = ['сумма', 'итого', 'стоимость', 'всего'];
const COMMENT_KEYWORDS = ['комментарий', 'примечание', 'примеч', 'коммент'];

/**
 * Checks whether a comment string contains unit-of-measure mentions
 * (шт, кг, м, м², компл и т.п.) — a trigger that the comment may carry
 * a quantity breakdown by subsystem/group.
 */
export function hasUnitMentions(comment: string | null | undefined): boolean {
  if (!comment) return false;
  const re = /(\bшт\b|штук[иа]?|\bм\.п\.?|\bм²|\bм2\b|\bм³|\bм3\b|\bкг\b|\bт\b|компл|\bуп\b|\bрул\b|\bподд\b|\bл\b)/i;
  return re.test(comment);
}

interface ColumnMap {
  nameCol: number;
  unitCol: number;
  qtyCol: number;
  priceCol: number | null;
  totalCol: number | null;
  commentCol: number | null;
  headerRow: number;
}

/**
 * Checks whether a cell value (lowercased) matches any keyword in the list.
 */
function matchesKeyword(cellValue: string, keywords: readonly string[]): boolean {
  const lower = cellValue.toLowerCase().trim();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Scans the first `maxRows` rows of a sheet to locate the header row
 * and column indices for name, unit, quantity, price, and total.
 */
function detectColumns(sheet: XLSX.WorkSheet, maxRows: number = 20): ColumnMap | null {
  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
  const searchEnd = Math.min(range.e.r, maxRows - 1);

  for (let r = range.s.r; r <= searchEnd; r++) {
    let nameCol = -1;
    let unitCol = -1;
    let qtyCol = -1;
    let priceCol: number | null = null;
    let totalCol: number | null = null;
    let commentCol: number | null = null;

    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellRef = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[cellRef];
      if (!cell || cell.v == null) continue;

      const val = String(cell.v);

      if (nameCol === -1 && matchesKeyword(val, NAME_KEYWORDS)) {
        nameCol = c;
      } else if (unitCol === -1 && matchesKeyword(val, UNIT_KEYWORDS)) {
        unitCol = c;
      } else if (qtyCol === -1 && matchesKeyword(val, QTY_KEYWORDS)) {
        qtyCol = c;
      } else if (priceCol == null && matchesKeyword(val, PRICE_KEYWORDS)) {
        // Only match "цена" if it's not also matching "стоимость" (total)
        if (!matchesKeyword(val, TOTAL_KEYWORDS)) {
          priceCol = c;
        }
      }
      // Total column: check last so "стоимость" / "сумма" can still be captured
      if (totalCol == null && matchesKeyword(val, TOTAL_KEYWORDS)) {
        totalCol = c;
      }
      if (commentCol == null && matchesKeyword(val, COMMENT_KEYWORDS)) {
        commentCol = c;
      }
    }

    // Minimum requirement: name + quantity columns found
    if (nameCol !== -1 && qtyCol !== -1) {
      // If unit column wasn't found, try to infer it (column right after name or left of quantity)
      if (unitCol === -1) {
        // Check if there's a column between name and qty
        if (qtyCol - nameCol > 1) {
          unitCol = nameCol + 1;
        }
      }
      return { nameCol, unitCol, qtyCol, priceCol, totalCol, commentCol, headerRow: r };
    }
  }

  return null;
}

/**
 * Determines if a row is a section header, total line, or otherwise
 * should be skipped (not a material row).
 */
function isSkippableRow(name: string, qty: unknown): boolean {
  if (!name || !name.trim()) return true;

  const lower = name.toLowerCase().trim();

  // Section headers usually end with a colon or are short all-caps strings
  if (lower.endsWith(':')) return true;

  // Total / subtotal rows
  const totalPatterns = [
    /^(итого|всего|итог|подитог|в том числе|ндс|налог|скидка|наценка|доставка)/i,
    /^(total|subtotal|sum)/i,
    /^раздел\s/i,
  ];
  if (totalPatterns.some((p) => p.test(lower))) return true;

  // If quantity is not a valid positive number, skip
  const numQty = typeof qty === 'number' ? qty : parseFloat(String(qty));
  if (isNaN(numQty) || numQty <= 0) return true;

  return false;
}

/**
 * Parses an Excel file and extracts material item rows.
 *
 * The parser scans the first 20 rows for a header containing recognizable
 * column names (in Russian), then reads all data rows below it.
 */
export function parseExcel(filePath: string): ParsedItem[] {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('Excel file contains no sheets');
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found`);
  }

  const columns = detectColumns(sheet);
  if (!columns) {
    // Fallback: try to parse as raw array rows
    return parseWithoutHeaders(sheet);
  }

  const { nameCol, unitCol, qtyCol, priceCol, totalCol, commentCol, headerRow } = columns;
  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
  const items: ParsedItem[] = [];
  let position = 1;

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const rawName = getCellString(sheet, r, nameCol);
    const rawQty = getCellValue(sheet, r, qtyCol);

    if (isSkippableRow(rawName, rawQty)) continue;

    const quantity = typeof rawQty === 'number' ? rawQty : parseFloat(String(rawQty));
    if (isNaN(quantity) || quantity <= 0) continue;

    const unit = unitCol !== -1 ? getCellString(sheet, r, unitCol) : '';
    const unitPrice = priceCol != null ? getCellNumber(sheet, r, priceCol) : undefined;
    const totalPrice = totalCol != null ? getCellNumber(sheet, r, totalCol) : undefined;
    const commentRaw = commentCol != null ? getCellString(sheet, r, commentCol).trim() : '';
    const comment = commentRaw.length > 0 ? commentRaw : null;

    items.push({
      position: position++,
      rawName: rawName.trim(),
      unit: normalizeUnit(unit),
      quantity,
      unitPrice,
      totalPrice,
      comment,
      commentHasUnits: hasUnitMentions(comment),
    });
  }

  return items;
}

/**
 * Fallback parser when no headers are detected.
 * Assumes columns are: [#, Name, Unit, Qty, Price?, Total?]
 */
function parseWithoutHeaders(sheet: XLSX.WorkSheet): ParsedItem[] {
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    defval: '',
  });

  const items: ParsedItem[] = [];
  let position = 1;

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 3) continue;

    // Try to find a text cell (name) and a numeric cell (quantity)
    let name = '';
    let qty = 0;
    let unit = '';

    for (let i = 0; i < row.length; i++) {
      const val = row[i];
      if (typeof val === 'string' && val.trim().length > 5 && !name) {
        name = val.trim();
      } else if (typeof val === 'string' && val.trim().length <= 5 && val.trim().length > 0 && !unit && name) {
        unit = val.trim();
      } else if (typeof val === 'number' && val > 0 && name && !qty) {
        qty = val;
      }
    }

    if (name && qty > 0) {
      items.push({
        position: position++,
        rawName: name,
        unit: normalizeUnit(unit),
        quantity: qty,
      });
    }
  }

  return items;
}

function getCellValue(sheet: XLSX.WorkSheet, row: number, col: number): unknown {
  const cellRef = XLSX.utils.encode_cell({ r: row, c: col });
  const cell = sheet[cellRef];
  return cell?.v ?? null;
}

function getCellString(sheet: XLSX.WorkSheet, row: number, col: number): string {
  const val = getCellValue(sheet, row, col);
  return val != null ? String(val) : '';
}

function getCellNumber(sheet: XLSX.WorkSheet, row: number, col: number): number | undefined {
  const val = getCellValue(sheet, row, col);
  if (val == null) return undefined;
  const num = typeof val === 'number' ? val : parseFloat(String(val));
  return isNaN(num) ? undefined : num;
}
