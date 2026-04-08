import { Fragment, useState } from 'react';
import type { ComparisonResult, OrderItem, InvoiceItem, Discrepancy, ItemParams } from '../../types';
import StatusBadge from '../ui/StatusBadge';

interface MaterialRowProps {
  result: ComparisonResult;
  orderItem?: OrderItem;
  invoiceItem?: InvoiceItem;
  invoiceByPosition?: Map<number, InvoiceItem>;
  index: number;
}

const severityConfig: Record<string, { label: string; classes: string; cellBg: string }> = {
  critical: { label: 'Критично', classes: 'bg-red-50 text-red-700 border border-red-200', cellBg: 'bg-red-50' },
  warning: { label: 'Внимание', classes: 'bg-amber-50 text-amber-700 border border-amber-200', cellBg: 'bg-amber-50' },
  info: { label: 'Инфо', classes: 'bg-sky-50 text-sky-700 border border-sky-200', cellBg: 'bg-sky-50' },
};

const quantityStatusLabels: Record<string, string> = {
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

function parseDiscrepancies(json: string | null): Discrepancy[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as Discrepancy[];
  } catch {
    return [];
  }
}

/** Безопасно достаёт ItemParams из OrderItem.params_json (сервер уже распарсил). */
function getParams(item?: OrderItem | InvoiceItem | null): ItemParams | null {
  if (!item) return null;
  const raw = item.params_json;
  if (!raw) return null;
  // Сервер парсит params_json в объект, но защищаемся на случай legacy-строки.
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as ItemParams; } catch { return null; }
  }
  return raw as ItemParams;
}

export default function MaterialRow({ result, orderItem, invoiceItem, invoiceByPosition, index }: MaterialRowProps) {
  const [expanded, setExpanded] = useState(false);

  const discrepancies = parseDiscrepancies(result.discrepancies_json);
  const orderParams = getParams(orderItem);
  const invoiceParams = getParams(invoiceItem);
  const hasParams = !!(orderParams || invoiceParams);
  const split = result.split_json ?? null;
  const hasComment = !!orderItem?.comment;
  const hasDetails =
    result.reasoning ||
    discrepancies.length > 0 ||
    result.quantity_status ||
    hasParams ||
    split != null ||
    hasComment;

  return (
    <>
      <tr
        className={`transition-colors duration-150 ${
          index % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'
        } ${hasDetails ? 'cursor-pointer hover:bg-slate-100/70' : ''}`}
        onClick={() => hasDetails && setExpanded(!expanded)}
      >
        {/* # */}
        <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-500 w-12">
          {orderItem?.position ?? invoiceItem?.position ?? '—'}
        </td>

        {/* Order */}
        <td className="px-4 py-3">
          {orderItem ? (
            <div>
              <p className="text-sm text-slate-900 line-clamp-2">{orderItem.raw_name}</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>
                  {orderItem.quantity} {orderItem.unit}
                </span>
                {hasComment && (
                  <span
                    title={orderItem.comment ?? ''}
                    className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                      orderItem.comment_has_units
                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                        : 'border-slate-200 bg-slate-50 text-slate-600'
                    }`}
                  >
                    коммент.
                  </span>
                )}
                {split && split.invoicePositions.length > 1 && (
                  <span className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                    разбито на {split.invoicePositions.length}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <span className="text-sm text-slate-400">—</span>
          )}
        </td>

        {/* Invoice */}
        <td className="px-4 py-3">
          {invoiceItem ? (
            <div>
              <p className="text-sm text-slate-900 line-clamp-2">{invoiceItem.raw_name}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {invoiceItem.quantity} {invoiceItem.unit}
                {invoiceItem.unit_price != null && (
                  <span className="ml-2 text-slate-400">
                    {invoiceItem.unit_price.toLocaleString('ru-RU')} руб.
                  </span>
                )}
              </p>
            </div>
          ) : (
            <span className="text-sm text-slate-400">—</span>
          )}
        </td>

        {/* Status */}
        <td className="px-4 py-3 whitespace-nowrap">
          <div className="flex items-center gap-2">
            <StatusBadge status={result.match_status} />
            {hasDetails && (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className={`h-4 w-4 text-slate-400 transition-transform duration-200 ${
                  expanded ? 'rotate-180' : ''
                }`}
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            )}
          </div>
        </td>
      </tr>

      {/* Detail panel */}
      {expanded && hasDetails && (
        <tr>
          <td colSpan={4} className="px-4 pb-4">
            <div className="ml-8 rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-4">
              {/* Comment from order */}
              {hasComment && orderItem?.comment && (
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wider text-slate-500 mb-1">
                    Комментарий из заказа
                  </h4>
                  <p
                    className={`text-sm whitespace-pre-line rounded border px-3 py-2 ${
                      orderItem.comment_has_units
                        ? 'border-amber-200 bg-amber-50 text-amber-900'
                        : 'border-slate-200 bg-white text-slate-700'
                    }`}
                  >
                    {orderItem.comment}
                  </p>
                </div>
              )}

              {/* 1→N split by subsystem / group */}
              {split && (split.invoicePositions.length > 1 || (split.byGroup && split.byGroup.length > 0)) && (
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wider text-slate-500 mb-2">
                    Разбивка по подсистемам
                  </h4>
                  <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-slate-500">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Подсистема</th>
                          <th className="px-3 py-2 text-left font-medium">Кол-во</th>
                          <th className="px-3 py-2 text-left font-medium">Строка счёта</th>
                          <th className="px-3 py-2 text-left font-medium">Наименование в счёте</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {(split.byGroup && split.byGroup.length > 0
                          ? split.byGroup.map((g) => ({
                              group: g.group,
                              invoicePosition: g.invoicePosition,
                              qty: g.qty,
                            }))
                          : split.invoicePositions.map((p) => ({
                              group: null as string | null,
                              invoicePosition: p,
                              qty: null as number | null,
                            }))
                        ).map((row, i) => {
                          const inv = invoiceByPosition?.get(row.invoicePosition);
                          return (
                            <tr key={`split-${i}`}>
                              <td className="px-3 py-1.5 font-medium text-slate-700">
                                {row.group ?? '—'}
                              </td>
                              <td className="px-3 py-1.5 text-slate-700">
                                {row.qty != null
                                  ? `${row.qty} ${split.invoiceUnit}`
                                  : inv
                                  ? `${inv.quantity} ${inv.unit}`
                                  : '—'}
                              </td>
                              <td className="px-3 py-1.5 text-slate-500">№ {row.invoicePosition}</td>
                              <td className="px-3 py-1.5 text-slate-700">
                                {inv?.raw_name ?? '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot className="bg-slate-50 text-slate-600">
                        <tr>
                          <td className="px-3 py-1.5 font-medium">Итого по счёту</td>
                          <td className="px-3 py-1.5 font-medium" colSpan={3}>
                            {split.totalInvoiceQty} {split.invoiceUnit}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* Reasoning */}
              {result.reasoning && (
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wider text-slate-500 mb-1">
                    Обоснование
                  </h4>
                  <p className="text-sm text-slate-700 whitespace-pre-line">{result.reasoning}</p>
                </div>
              )}

              {/* Quantity */}
              {result.quantity_status && (
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wider text-slate-500 mb-1">
                    Количество
                  </h4>
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-slate-700">
                      {quantityStatusLabels[result.quantity_status] ?? result.quantity_status}
                    </span>
                    {result.quantity_diff_pct != null && (
                      <span
                        className={`font-medium ${
                          Math.abs(result.quantity_diff_pct) < 1
                            ? 'text-emerald-600'
                            : Math.abs(result.quantity_diff_pct) < 5
                            ? 'text-amber-600'
                            : 'text-red-600'
                        }`}
                      >
                        {result.quantity_diff_pct > 0 ? '+' : ''}
                        {result.quantity_diff_pct.toFixed(1)}%
                      </span>
                    )}
                    {result.conversion_note && (
                      <span className="text-slate-500 text-xs">({result.conversion_note})</span>
                    )}
                  </div>
                </div>
              )}

              {/* Confidence */}
              {result.match_confidence != null && (
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wider text-slate-500 mb-1">
                    Уверенность
                  </h4>
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 max-w-[200px] rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          result.match_confidence >= 0.8
                            ? 'bg-emerald-500'
                            : result.match_confidence >= 0.5
                            ? 'bg-amber-500'
                            : 'bg-red-500'
                        }`}
                        style={{ width: `${result.match_confidence * 100}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium text-slate-700">
                      {Math.round(result.match_confidence * 100)}%
                    </span>
                  </div>
                </div>
              )}

              {/* Параметры (side-by-side таблица) */}
              {hasParams && (
                <ParametersTable
                  orderParams={orderParams}
                  invoiceParams={invoiceParams}
                  discrepancies={discrepancies}
                />
              )}

              {/* Discrepancies */}
              {discrepancies.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wider text-slate-500 mb-2">
                    Расхождения
                  </h4>
                  <div className="space-y-2">
                    {discrepancies.map((d, i) => {
                      const sev = severityConfig[d.severity] ?? severityConfig.info;
                      return (
                        <div
                          key={i}
                          className="flex flex-wrap items-start gap-2 rounded-md border border-slate-200 bg-white px-3 py-2"
                        >
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${sev.classes}`}
                          >
                            {sev.label}
                          </span>
                          <span className="text-sm font-medium text-slate-900">{d.parameter}</span>
                          <div className="flex items-center gap-1 text-sm">
                            <span className="text-slate-500">
                              {d.spec_value ?? '—'}
                            </span>
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 16 16"
                              fill="currentColor"
                              className="h-3 w-3 text-slate-400 shrink-0"
                              aria-hidden="true"
                            >
                              <path
                                fillRule="evenodd"
                                d="M2 8a.75.75 0 01.75-.75h8.69L8.22 4.03a.75.75 0 011.06-1.06l4.5 4.5a.75.75 0 010 1.06l-4.5 4.5a.75.75 0 01-1.06-1.06l3.22-3.22H2.75A.75.75 0 012 8z"
                                clipRule="evenodd"
                              />
                            </svg>
                            <span className="text-slate-500">
                              {d.invoice_value ?? '—'}
                            </span>
                          </div>
                          {d.comment && (
                            <p className="basis-full text-xs text-slate-500 mt-0.5">{d.comment}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ParametersTable: side-by-side таблица параметров (Геометрия / Материал / Стандарты).
// Заполняется из ItemParams, извлечённых на Stage A (parameter-extractor).
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
  // У сервера в discrepancy.parameter лежит русский label, но parameter_code тоже передаётся
  // в DeterministicMismatch. Здесь мы fallback-сравниваем по нормализованному label.
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

function ParametersTable({ orderParams, invoiceParams, discrepancies }: ParametersTableProps) {
  const rows = collectRows(orderParams, invoiceParams);

  if (rows.length === 0) {
    // Показываем хотя бы категорию/тип, если параметров нет.
    if (!orderParams && !invoiceParams) return null;
  }

  // Группируем строки по group для вывода секциями.
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
