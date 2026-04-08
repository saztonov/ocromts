import { useMemo } from 'react';
import type {
  ComparisonResult,
  OrderItem,
  InvoiceItem,
  MatchStatus,
} from '../../types';
import StatusBadge from '../ui/StatusBadge';
import EmptyState from '../ui/EmptyState';
import {
  groupByBoth,
  type BothGroup,
  type InvoiceRow,
} from './groupResults';

interface ComparisonTableBothProps {
  results: ComparisonResult[];
  orderItems: OrderItem[];
  invoiceItems: InvoiceItem[];
  filter: MatchStatus | 'all';
}

export default function ComparisonTableBoth({
  results,
  orderItems,
  invoiceItems,
  filter,
}: ComparisonTableBothProps) {
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

  const groups = useMemo(
    () => groupByBoth(results, orderMap, invoiceMap, invoiceByPosition),
    [results, orderMap, invoiceMap, invoiceByPosition]
  );

  const filtered = useMemo(() => {
    if (filter === 'all') return groups;
    return groups.filter((g) => {
      const lmatch = g.llm.result?.match_status === filter;
      const fmatch = g.fuzzy.result?.match_status === filter;
      return lmatch || fmatch;
    });
  }, [groups, filter]);

  if (filtered.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <EmptyState
          title="Нет результатов"
          description="Для выбранного фильтра нет записей"
        />
      </div>
    );
  }

  // Full-width breakout — вырываемся из `max-w-7xl` родительского <main>.
  return (
    <div className="relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen px-4 sm:px-6 lg:px-8">
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th
                  rowSpan={2}
                  className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 w-12 border-r border-slate-200"
                >
                  #
                </th>
                <th
                  colSpan={2}
                  className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-600 border-r border-slate-200"
                >
                  Заказ
                </th>
                <th
                  colSpan={3}
                  className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-sky-700 bg-sky-50 border-r border-slate-200"
                >
                  LLM-анализ
                </th>
                <th
                  colSpan={3}
                  className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-emerald-700 bg-emerald-50"
                >
                  Fuzzy-анализ
                </th>
              </tr>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">
                  Номенклатура заказа
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500 w-28 border-r border-slate-200">
                  Кол-во
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500 bg-sky-50/60">
                  Номенклатура счёта
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500 w-28 bg-sky-50/60">
                  Кол-во
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500 w-36 bg-sky-50/60 border-r border-slate-200">
                  Статус
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500 bg-emerald-50/60">
                  Номенклатура счёта
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500 w-28 bg-emerald-50/60">
                  Кол-во
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500 w-36 bg-emerald-50/60">
                  Статус
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((group, idx) => (
                <BothGroupRows key={group.key} group={group} index={idx} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface BothGroupRowsProps {
  group: BothGroup;
  index: number;
}

function BothGroupRows({ group, index }: BothGroupRowsProps) {
  const { orderItem, llm, fuzzy, rowSpan, diverged } = group;
  const zebra = index % 2 === 0 ? 'bg-white' : 'bg-slate-50/40';
  const divergedBg = diverged ? 'bg-amber-50/50' : zebra;

  // Пустой invoice-row для заполнения дыр в стороне с меньшим количеством строк счёта.
  const emptyRow: InvoiceRow = { invoiceItem: null, quantity: null, unit: null };

  const rows = Array.from({ length: rowSpan }, (_, i) => ({
    llmRow: llm.invoiceRows[i] ?? emptyRow,
    fuzzyRow: fuzzy.invoiceRows[i] ?? emptyRow,
  }));

  return (
    <>
      {rows.map(({ llmRow, fuzzyRow }, i) => {
        const isFirst = i === 0;
        return (
          <tr key={`${group.key}-${i}`} className={divergedBg}>
            {isFirst && (
              <>
                <td
                  rowSpan={rowSpan}
                  className="whitespace-nowrap px-4 py-3 text-sm text-slate-500 align-top border-r border-slate-200"
                >
                  {group.position}
                </td>
                <td rowSpan={rowSpan} className="px-4 py-3 align-top">
                  {orderItem ? (
                    <div>
                      <p className="text-sm text-slate-900">{orderItem.raw_name}</p>
                      {(orderItem.comment || rowSpan > 1) && (
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                          {orderItem.comment && (
                            <span
                              title={orderItem.comment}
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
                      )}
                    </div>
                  ) : (
                    <span className="text-sm text-slate-400">—</span>
                  )}
                </td>
                <td
                  rowSpan={rowSpan}
                  className="whitespace-nowrap px-4 py-3 text-sm text-slate-700 align-top border-r border-slate-200"
                >
                  {orderItem ? `${orderItem.quantity} ${orderItem.unit}` : '—'}
                </td>
              </>
            )}

            {/* LLM */}
            <InvoiceCells row={llmRow} sideBg="bg-sky-50/20" />
            {isFirst && (
              <td
                rowSpan={rowSpan}
                className="px-4 py-3 whitespace-nowrap align-top bg-sky-50/20 border-r border-slate-200"
              >
                {llm.result ? <StatusBadge status={llm.result.match_status} /> : <span className="text-slate-400">—</span>}
              </td>
            )}

            {/* Fuzzy */}
            <InvoiceCells row={fuzzyRow} sideBg="bg-emerald-50/20" />
            {isFirst && (
              <td
                rowSpan={rowSpan}
                className="px-4 py-3 whitespace-nowrap align-top bg-emerald-50/20"
              >
                {fuzzy.result ? (
                  <StatusBadge status={fuzzy.result.match_status} />
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </td>
            )}
          </tr>
        );
      })}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function InvoiceCells({ row, sideBg }: { row: InvoiceRow; sideBg: string }) {
  const inv = row.invoiceItem;
  return (
    <>
      <td className={`px-4 py-3 align-top ${sideBg}`}>
        {inv ? (
          <div>
            <p className="text-sm text-slate-900">{inv.raw_name}</p>
            {row.groupLabel && (
              <p className="mt-0.5 text-xs text-slate-500">{row.groupLabel}</p>
            )}
          </div>
        ) : (
          <span className="text-sm text-slate-400">—</span>
        )}
      </td>
      <td className={`whitespace-nowrap px-4 py-3 align-top text-sm text-slate-700 ${sideBg}`}>
        {row.quantity != null && row.unit
          ? `${row.quantity} ${row.unit}`
          : inv
          ? `${inv.quantity} ${inv.unit}`
          : '—'}
      </td>
    </>
  );
}
