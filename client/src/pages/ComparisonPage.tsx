import { useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getComparison } from '../api/client';
import type { MatchStatus, ComparisonSummary } from '../types';
import SummaryBar from '../components/comparison/SummaryBar';
import FilterTabs from '../components/comparison/FilterTabs';
import ComparisonTable from '../components/comparison/ComparisonTable';
import Spinner from '../components/ui/Spinner';
import StatusBadge from '../components/ui/StatusBadge';

export default function ComparisonPage() {
  const { id } = useParams<{ id: string }>();
  const [filter, setFilter] = useState<MatchStatus | 'all'>('all');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['comparison', id],
    queryFn: () => getComparison(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.comparison.status;
      if (status && status !== 'done' && status !== 'error') {
        return 2000;
      }
      return false;
    },
  });

  const comparison = data?.comparison;
  const results = data?.results ?? [];
  const orderItems = data?.orderItems ?? [];
  const invoiceItems = data?.invoiceItems ?? [];

  const summary: ComparisonSummary | null = useMemo(() => {
    if (comparison?.summary_json) {
      try {
        return JSON.parse(comparison.summary_json) as ComparisonSummary;
      } catch {
        return null;
      }
    }
    return null;
  }, [comparison?.summary_json]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: results.length };
    for (const r of results) {
      c[r.match_status] = (c[r.match_status] ?? 0) + 1;
    }
    return c;
  }, [results]);

  const isPending = comparison?.status === 'pending' || comparison?.status === 'parsing' || comparison?.status === 'comparing';

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors duration-150"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
            clipRule="evenodd"
          />
        </svg>
        Назад к списку
      </Link>

      {isLoading && (
        <div className="flex flex-col items-center justify-center py-20">
          <Spinner size="lg" />
          <p className="mt-4 text-sm text-slate-500">Загрузка...</p>
        </div>
      )}

      {isError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6">
          <h2 className="text-lg font-semibold text-red-900">Ошибка загрузки</h2>
          <p className="mt-1 text-sm text-red-700">
            {error instanceof Error ? error.message : 'Не удалось загрузить данные сверки'}
          </p>
        </div>
      )}

      {comparison && (
        <>
          {/* Header */}
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm px-6 py-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-bold text-slate-900">
                  {comparison.name ?? 'Сверка'}
                </h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="h-3.5 w-3.5"
                      aria-hidden="true"
                    >
                      <path d="M3.5 2A1.5 1.5 0 002 3.5v9A1.5 1.5 0 003.5 14h9a1.5 1.5 0 001.5-1.5v-7A1.5 1.5 0 0012.5 5H8.207l-.293-.293A1.5 1.5 0 006.914 4.5H3.5z" />
                    </svg>
                    {comparison.order_filename}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="h-3.5 w-3.5"
                      aria-hidden="true"
                    >
                      <path d="M3.5 2A1.5 1.5 0 002 3.5v9A1.5 1.5 0 003.5 14h9a1.5 1.5 0 001.5-1.5v-7A1.5 1.5 0 0012.5 5H8.207l-.293-.293A1.5 1.5 0 006.914 4.5H3.5z" />
                    </svg>
                    {comparison.invoice_filename}
                  </span>
                </div>
              </div>
              <StatusBadge status={comparison.status} />
            </div>
          </div>

          {/* Processing state */}
          {isPending && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm py-20">
              <Spinner size="lg" />
              <p className="mt-4 text-base font-medium text-slate-700">
                {comparison.status === 'pending' && 'Ожидание в очереди...'}
                {comparison.status === 'parsing' && 'Анализ документов...'}
                {comparison.status === 'comparing' && 'Сравнение позиций...'}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                Это может занять некоторое время
              </p>
            </div>
          )}

          {/* Error state */}
          {comparison.status === 'error' && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-6">
              <div className="flex items-start gap-3">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-5 w-5 mt-0.5 text-red-500 shrink-0"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
                    clipRule="evenodd"
                  />
                </svg>
                <div>
                  <h2 className="text-base font-semibold text-red-900">Ошибка при обработке</h2>
                  <p className="mt-1 text-sm text-red-700">
                    {comparison.error_message ?? 'Произошла неизвестная ошибка'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Done state — results */}
          {comparison.status === 'done' && (
            <>
              {summary && <SummaryBar summary={summary} />}
              <FilterTabs
                activeFilter={filter}
                onFilterChange={setFilter}
                counts={counts}
              />
              <ComparisonTable
                results={results}
                orderItems={orderItems}
                invoiceItems={invoiceItems}
                filter={filter}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
