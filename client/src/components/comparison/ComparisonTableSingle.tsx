import { useMemo, useState } from 'react';
import type {
  ComparisonResult,
  OrderItem,
  InvoiceItem,
  MatchStatus,
} from '../../types';
import StatusBadge from '../ui/StatusBadge';
import EmptyState from '../ui/EmptyState';
import {
  groupBySingle,
  type SingleGroup,
  type InvoiceRow,
} from './groupResults';
import {
  parseDiscrepancies,
  getParams,
  ParametersTable,
  severityConfig,
  quantityStatusLabels,
} from './materialDetails';

interface ComparisonTableSingleProps {
  results: ComparisonResult[];
  orderItems: OrderItem[];
  invoiceItems: InvoiceItem[];
  filter: MatchStatus | 'all';
}

export default function ComparisonTableSingle({
  results,
  orderItems,
  invoiceItems,
  filter,
}: ComparisonTableSingleProps) {
  const orderMap = useMemo(() => {
    const m = new Map<number, OrderItem>();
    for (const it of orderItems) m.set(it.id, it);
    return m;
  }, [orderItems]);

  const invoiceMap = useMemo(() => {
    const m = new Map<number, InvoiceItem>();
    for (const it of invoiceItems) m.set(it.id, it);
    return m;
  }, [invoiceItems]);

  const invoiceByPosition = useMemo(() => {
    const m = new Map<number, InvoiceItem>();
    for (const it of invoiceItems) m.set(it.position, it);
    return m;
  }, [invoiceItems]);

  const filteredResults = useMemo(() => {
    if (filter === 'all') return results;
    return results.filter((r) => r.match_status === filter);
  }, [results, filter]);

  const groups = useMemo(
    () => groupBySingle(filteredResults, orderMap, invoiceMap, invoiceByPosition),
    [filteredResults, orderMap, invoiceMap, invoiceByPosition]
  );

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <EmptyState
          title="Нет результатов"
          description="Для выбранного фильтра нет записей"
        />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 w-12">
                #
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                Номенклатура заказа
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 w-32">
                Кол-во
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                Номенклатура счёта
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 w-32">
                Кол-во
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 w-40">
                Статус
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {groups.map((group, idx) => (
              <GroupRows key={group.key} group={group} index={idx} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface GroupRowsProps {
  group: SingleGroup;
  index: number;
}

function GroupRows({ group, index }: GroupRowsProps) {
  const [expanded, setExpanded] = useState(false);
  const { orderItem, result, invoiceRows } = group;

  const discrepancies = parseDiscrepancies(result.discrepancies_json);
  const orderParams = getParams(orderItem);
  // Для деталей берём параметры первой реальной позиции счёта.
  const firstInvoice = invoiceRows.find((r) => r.invoiceItem != null)?.invoiceItem ?? null;
  const invoiceParams = getParams(firstInvoice);
  const hasParams = !!(orderParams || invoiceParams);
  const hasComment = !!orderItem?.comment;
  const hasDetails =
    !!result.reasoning ||
    discrepancies.length > 0 ||
    !!result.quantity_status ||
    hasParams ||
    hasComment ||
    result.match_confidence != null;

  const rowSpan = invoiceRows.length;
  const zebra = index % 2 === 0 ? 'bg-white' : 'bg-slate-50/50';
  const clickable = hasDetails ? 'cursor-pointer hover:bg-slate-100/70' : '';
  const toggle = () => hasDetails && setExpanded((v) => !v);

  return (
    <>
      {invoiceRows.map((invRow, i) => {
        const isFirst = i === 0;
        return (
          <tr
            key={`${group.key}-r${i}`}
            className={`transition-colors duration-150 ${zebra} ${clickable}`}
            onClick={toggle}
          >
            {isFirst && (
              <>
                <td
                  rowSpan={rowSpan}
                  className="whitespace-nowrap px-4 py-3 text-sm text-slate-500 align-top"
                >
                  {group.position}
                </td>
                <td rowSpan={rowSpan} className="px-4 py-3 align-top">
                  {orderItem ? (
                    <div>
                      <p className="text-sm text-slate-900">{orderItem.raw_name}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
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
                        {rowSpan > 1 && (
                          <span className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                            разбито на {rowSpan}
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <span className="text-sm text-slate-400">—</span>
                  )}
                </td>
                <td
                  rowSpan={rowSpan}
                  className="whitespace-nowrap px-4 py-3 align-top text-sm text-slate-700"
                >
                  {orderItem ? `${orderItem.quantity} ${orderItem.unit}` : '—'}
                </td>
              </>
            )}

            <InvoiceCells row={invRow} />

            {isFirst && (
              <td rowSpan={rowSpan} className="px-4 py-3 whitespace-nowrap align-top">
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
            )}
          </tr>
        );
      })}

      {expanded && hasDetails && (
        <tr>
          <td colSpan={6} className="px-4 pb-4">
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

              {/* Parameters */}
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
                            <span className="text-slate-500">{d.spec_value ?? '—'}</span>
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
                            <span className="text-slate-500">{d.invoice_value ?? '—'}</span>
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

function InvoiceCells({ row }: { row: InvoiceRow }) {
  const inv = row.invoiceItem;
  return (
    <>
      <td className="px-4 py-3 align-top">
        {inv ? (
          <div>
            <p className="text-sm text-slate-900">{inv.raw_name}</p>
            {(row.groupLabel || inv.unit_price != null) && (
              <p className="mt-0.5 text-xs text-slate-500">
                {row.groupLabel && <span className="mr-2">{row.groupLabel}</span>}
                {inv.unit_price != null && (
                  <span className="text-slate-400">
                    {inv.unit_price.toLocaleString('ru-RU')} руб.
                  </span>
                )}
              </p>
            )}
          </div>
        ) : (
          <span className="text-sm text-slate-400">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 align-top text-sm text-slate-700">
        {row.quantity != null && row.unit
          ? `${row.quantity} ${row.unit}`
          : inv
          ? `${inv.quantity} ${inv.unit}`
          : '—'}
      </td>
    </>
  );
}

