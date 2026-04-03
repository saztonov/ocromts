import { useMemo } from 'react';
import type { ComparisonResult, OrderItem, InvoiceItem, MatchStatus } from '../../types';
import MaterialRow from './MaterialRow';
import EmptyState from '../ui/EmptyState';

interface ComparisonTableProps {
  results: ComparisonResult[];
  orderItems: OrderItem[];
  invoiceItems: InvoiceItem[];
  filter: MatchStatus | 'all';
}

export default function ComparisonTable({
  results,
  orderItems,
  invoiceItems,
  filter,
}: ComparisonTableProps) {
  const orderMap = useMemo(() => {
    const m = new Map<number, OrderItem>();
    for (const item of orderItems) {
      m.set(item.id, item);
    }
    return m;
  }, [orderItems]);

  const invoiceMap = useMemo(() => {
    const m = new Map<number, InvoiceItem>();
    for (const item of invoiceItems) {
      m.set(item.id, item);
    }
    return m;
  }, [invoiceItems]);

  const filtered = useMemo(() => {
    if (filter === 'all') return results;
    return results.filter((r) => r.match_status === filter);
  }, [results, filter]);

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

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="sticky top-0 bg-slate-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 w-12">
                #
              </th>
              <th className="sticky top-0 bg-slate-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                Заказ
              </th>
              <th className="sticky top-0 bg-slate-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                Счёт
              </th>
              <th className="sticky top-0 bg-slate-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 w-40">
                Статус
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((result, idx) => (
              <MaterialRow
                key={result.id}
                result={result}
                orderItem={result.order_item_id != null ? orderMap.get(result.order_item_id) : undefined}
                invoiceItem={result.invoice_item_id != null ? invoiceMap.get(result.invoice_item_id) : undefined}
                index={idx}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
