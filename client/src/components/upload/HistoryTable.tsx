import { Link } from 'react-router-dom';
import type { Comparison } from '../../types';
import StatusBadge from '../ui/StatusBadge';
import EmptyState from '../ui/EmptyState';

interface HistoryTableProps {
  comparisons: Comparison[];
  onDelete: (id: string) => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

export default function HistoryTable({ comparisons, onDelete }: HistoryTableProps) {
  const handleDelete = (id: string) => {
    if (window.confirm('Удалить эту сверку?')) {
      onDelete(id);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-6 py-4">
        <h2 className="text-lg font-semibold text-slate-900">История сверок</h2>
      </div>

      {comparisons.length === 0 ? (
        <EmptyState
          title="Нет сверок"
          description="Загрузите заказ и счёт для начала работы"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left">
                <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">
                  Дата
                </th>
                <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">
                  Название
                </th>
                <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">
                  Файлы
                </th>
                <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">
                  Статус
                </th>
                <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">
                  <span className="sr-only">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {comparisons.map((c) => (
                <tr
                  key={c.id}
                  className="group transition-colors duration-150 hover:bg-slate-50"
                >
                  <td className="whitespace-nowrap px-6 py-3 text-slate-500">
                    {formatDate(c.created_at)}
                  </td>
                  <td className="px-6 py-3">
                    <Link
                      to={`/comparisons/${c.id}`}
                      className="font-medium text-slate-900 hover:text-indigo-600 transition-colors duration-150"
                    >
                      {c.name ?? 'Без названия'}
                    </Link>
                  </td>
                  <td className="px-6 py-3 text-slate-500">
                    <div className="flex flex-col gap-0.5">
                      <span className="truncate max-w-[200px]" title={c.order_filename}>
                        {c.order_filename}
                      </span>
                      <span className="truncate max-w-[200px]" title={c.invoice_filename}>
                        {c.invoice_filename}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-6 py-3 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(c.id);
                      }}
                      className="rounded-lg p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                      title="Удалить"
                      aria-label="Удалить сверку"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                        <path
                          fillRule="evenodd"
                          d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 01.78.72l.5 6.5a.75.75 0 01-1.499.115l-.5-6.5a.75.75 0 01.72-.78zm3.62.72a.75.75 0 00-1.5-.115l-.5 6.5a.75.75 0 001.5.115l.5-6.5z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
