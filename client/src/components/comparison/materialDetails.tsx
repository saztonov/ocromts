import { Fragment } from 'react';
import type {
  Discrepancy,
  ItemParams,
  OrderItem,
  InvoiceItem,
} from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Общие константы / helpers для панели деталей сравнения.
// Используются как в ComparisonTableSingle (раскрывающиеся детали),
// так и для инспекции отдельных полей.

export const severityConfig: Record<string, { label: string; classes: string; cellBg: string }> = {
  critical: { label: 'Критично', classes: 'bg-red-50 text-red-700 border border-red-200', cellBg: 'bg-red-50' },
  warning: { label: 'Внимание', classes: 'bg-amber-50 text-amber-700 border border-amber-200', cellBg: 'bg-amber-50' },
  info: { label: 'Инфо', classes: 'bg-sky-50 text-sky-700 border border-sky-200', cellBg: 'bg-sky-50' },
};

export const quantityStatusLabels: Record<string, string> = {
  exact: 'Точное совпадение',
  within_tolerance: 'В пределах допуска',
  over: 'Больше в счёте',
  under: 'Меньше в счёте',
  incompatible_units: 'Несовместимые единицы',
};

const groupLabels: Record<string, string> = {
  geometry: 'Геометрия',
  material: 'Материал',
  standards: 'Стандарты',
  extra: 'Прочее',
};

export function parseDiscrepancies(json: unknown): Discrepancy[] {
  if (!json) return [];
  // Сервер может уже распарсить discrepancies_json в массив (routes/comparisons.ts),
  // а тип в client/src/types/index.ts остался `string | null` из legacy-времён.
  if (Array.isArray(json)) return json as Discrepancy[];
  if (typeof json === 'string') {
    try {
      return JSON.parse(json) as Discrepancy[];
    } catch {
      return [];
    }
  }
  return [];
}

/** Безопасно достаёт ItemParams из OrderItem.params_json (сервер уже распарсил). */
export function getParams(item?: OrderItem | InvoiceItem | null): ItemParams | null {
  if (!item) return null;
  const raw = item.params_json;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as ItemParams; } catch { return null; }
  }
  return raw as ItemParams;
}

// ─────────────────────────────────────────────────────────────────────────────
// ParametersTable: side-by-side таблица параметров (Геометрия / Материал / Стандарты).
// Различающиеся ячейки подсвечиваются согласно severity из discrepancies.

interface ParametersTableProps {
  orderParams: ItemParams | null;
  invoiceParams: ItemParams | null;
  discrepancies: Discrepancy[];
}

interface ParamRow {
  code: string;
  group: string;
  orderValue: string | number | null;
  invoiceValue: string | number | null;
}

function collectRows(
  order: ItemParams | null,
  invoice: ItemParams | null
): ParamRow[] {
  const groups: Array<keyof Pick<ItemParams, 'geometry' | 'material' | 'standards' | 'extra'>> = [
    'geometry',
    'material',
    'standards',
    'extra',
  ];
  const rows: ParamRow[] = [];

  for (const groupName of groups) {
    const orderGroup = order?.[groupName] ?? {};
    const invoiceGroup = invoice?.[groupName] ?? {};
    const allKeys = new Set<string>([
      ...Object.keys(orderGroup),
      ...Object.keys(invoiceGroup),
    ]);
    for (const key of allKeys) {
      const orderValue = (orderGroup as Record<string, number | string | null>)[key] ?? null;
      const invoiceValue = (invoiceGroup as Record<string, number | string | null>)[key] ?? null;
      if (orderValue == null && invoiceValue == null) continue;
      rows.push({ code: key, group: groupName, orderValue, invoiceValue });
    }
  }

  return rows;
}

function severityForParam(code: string, discrepancies: Discrepancy[]): string | null {
  const normalized = code.toLowerCase();
  for (const d of discrepancies) {
    const paramRaw = d.parameter ?? '';
    if (paramRaw.toLowerCase().includes(normalized)) return d.severity;
  }
  return null;
}

function formatValue(v: string | number | null): string {
  if (v == null || v === '') return '—';
  return String(v);
}

export function ParametersTable({ orderParams, invoiceParams, discrepancies }: ParametersTableProps) {
  const rows = collectRows(orderParams, invoiceParams);

  if (rows.length === 0) {
    if (!orderParams && !invoiceParams) return null;
  }

  const grouped: Record<string, ParamRow[]> = {};
  for (const r of rows) {
    if (!grouped[r.group]) grouped[r.group] = [];
    grouped[r.group]!.push(r);
  }

  return (
    <div>
      <h4 className="text-xs font-medium uppercase tracking-wider text-slate-500 mb-2">
        Параметры материала
      </h4>

      {/* Заголовок: категория и тип */}
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-slate-600">
        {(orderParams?.category || invoiceParams?.category) && (
          <span>
            <span className="text-slate-400">Категория:</span>{' '}
            <span className="font-medium text-slate-700">
              {orderParams?.category ?? invoiceParams?.category}
            </span>
          </span>
        )}
        {(orderParams?.type || invoiceParams?.type) && (
          <span>
            <span className="text-slate-400">Тип:</span>{' '}
            <span className="font-medium text-slate-700">
              {orderParams?.type ?? invoiceParams?.type ?? '—'}
            </span>
          </span>
        )}
        {(orderParams?.shape || invoiceParams?.shape) && (
          <span>
            <span className="text-slate-400">Форма:</span>{' '}
            <span className="font-medium text-slate-700">
              {orderParams?.shape ?? invoiceParams?.shape}
            </span>
            {orderParams?.shape && invoiceParams?.shape && orderParams.shape !== invoiceParams.shape && (
              <span className="ml-1 text-red-600">
                ≠ {invoiceParams.shape}
              </span>
            )}
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Параметр</th>
              <th className="px-3 py-2 text-left font-medium">Заказ</th>
              <th className="px-3 py-2 text-left font-medium">Накладная</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {Object.entries(grouped).map(([group, groupRows]) => (
              <Fragment key={`grp-${group}`}>
                <tr className="bg-slate-50/60">
                  <td colSpan={3} className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    {groupLabels[group] ?? group}
                  </td>
                </tr>
                {groupRows.map((row) => {
                  const severity = severityForParam(row.code, discrepancies);
                  const sev = severity ? severityConfig[severity] : null;
                  const differs =
                    row.orderValue != null &&
                    row.invoiceValue != null &&
                    String(row.orderValue) !== String(row.invoiceValue);
                  const cellHighlight = sev?.cellBg ?? (differs ? 'bg-amber-50' : '');
                  return (
                    <tr key={`${group}-${row.code}`}>
                      <td className="px-3 py-1.5 font-medium text-slate-700">{row.code}</td>
                      <td className={`px-3 py-1.5 text-slate-700 ${cellHighlight}`}>
                        {formatValue(row.orderValue)}
                      </td>
                      <td className={`px-3 py-1.5 text-slate-700 ${cellHighlight}`}>
                        {formatValue(row.invoiceValue)}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
