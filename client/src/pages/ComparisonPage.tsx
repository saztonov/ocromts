import { useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getComparison, cancelComparison, startCompareWithMethod, retryStageAItem } from '../api/client';
import type { MatchStatus, ComparisonSummary, ComparisonMethod } from '../types';
import SummaryBar from '../components/comparison/SummaryBar';
import FilterTabs from '../components/comparison/FilterTabs';
import ComparisonTable from '../components/comparison/ComparisonTable';
import Spinner from '../components/ui/Spinner';
import StatusBadge from '../components/ui/StatusBadge';
import ProgressBar from '../components/ui/ProgressBar';

export default function ComparisonPage() {
  const { id } = useParams<{ id: string }>();
  const [filter, setFilter] = useState<MatchStatus | 'all'>('all');
  const [isCancelling, setIsCancelling] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['comparison', id],
    queryFn: () => getComparison(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.comparison.status;
      if (status === 'awaiting_method') return 5000;
      if (status && !['done', 'error', 'cancelled'].includes(status)) {
        return 1500;
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

  const isPending = comparison?.status === 'pending'
    || comparison?.status === 'parsing'
    || comparison?.status === 'extracting'
    || comparison?.status === 'comparing';

  const [chosenMethod, setChosenMethod] = useState<ComparisonMethod>('llm');
  const [isStartingCompare, setIsStartingCompare] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  const handleStartCompare = async () => {
    if (!id) return;
    setIsStartingCompare(true);
    try {
      await startCompareWithMethod(id, chosenMethod);
      queryClient.invalidateQueries({ queryKey: ['comparison', id] });
    } catch (e) {
      console.error('Start compare failed:', e);
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setIsStartingCompare(false);
    }
  };

  const handleRetry = async (side: 'order' | 'invoice', position: number) => {
    if (!id) return;
    const key = `${side}-${position}`;
    setRetrying(key);
    try {
      await retryStageAItem(id, side, position);
      queryClient.invalidateQueries({ queryKey: ['comparison', id] });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setRetrying(null);
    }
  };

  const handleCancel = async () => {
    if (!id) return;
    setIsCancelling(true);
    try {
      await cancelComparison(id);
      queryClient.invalidateQueries({ queryKey: ['comparison', id] });
    } catch (e) {
      console.error('Cancel failed:', e);
    } finally {
      setIsCancelling(false);
    }
  };

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
              <div className="flex items-center gap-3">
                {comparison.status === 'done' && (
                  <a
                    href={`/api/comparisons/${comparison.id}/export`}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                      <path fillRule="evenodd" d="M10 3a.75.75 0 01.75.75v7.69l2.22-2.22a.75.75 0 111.06 1.06l-3.5 3.5a.75.75 0 01-1.06 0l-3.5-3.5a.75.75 0 111.06-1.06l2.22 2.22V3.75A.75.75 0 0110 3zM3.75 14a.75.75 0 01.75.75v1.5c0 .138.112.25.25.25h10.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 0115.25 18H4.75A1.75 1.75 0 013 16.25v-1.5a.75.75 0 01.75-.75z" clipRule="evenodd" />
                    </svg>
                    Скачать Excel
                  </a>
                )}
                <StatusBadge status={comparison.status} />
              </div>
            </div>
          </div>

          {/* Processing state */}
          {isPending && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm py-12 px-6">
              <Spinner size="lg" />
              <p className="mt-4 text-base font-medium text-slate-700">
                {comparison.status === 'pending' && 'Ожидание в очереди...'}
                {comparison.status === 'parsing' && 'Анализ документов...'}
                {comparison.status === 'extracting' && (
                  <>Извлечение параметров (Stage A): {comparison.stage_a_done} / {comparison.stage_a_total}</>
                )}
                {comparison.status === 'comparing' && 'Сравнение позиций...'}
              </p>
              <div className="mt-4 w-full max-w-xs">
                <ProgressBar progress={comparison.progress} />
              </div>
              <button
                onClick={handleCancel}
                disabled={isCancelling}
                className="mt-5 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-red-600 hover:text-red-700 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
                    clipRule="evenodd"
                  />
                </svg>
                {isCancelling ? 'Отмена...' : 'Остановить сверку'}
              </button>
            </div>
          )}

          {/* Cancelled state */}
          {comparison.status === 'cancelled' && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
              <div className="flex items-start gap-3">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-5 w-5 mt-0.5 text-slate-500 shrink-0"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
                    clipRule="evenodd"
                  />
                </svg>
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Сверка отменена</h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Обработка была остановлена пользователем
                  </p>
                </div>
              </div>
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

          {/* Live Stage A tables — visible during extraction and after */}
          {(comparison.status === 'extracting' || comparison.status === 'awaiting_method') && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <StageALiveTable
                title={`Заказ (${orderItems.length})`}
                items={orderItems}
                side="order"
                failedPosition={comparison.stage_a_failed_side === 'order' ? comparison.stage_a_failed_position : null}
                onRetry={handleRetry}
                retryingKey={retrying}
              />
              <StageALiveTable
                title={`Счёт (${invoiceItems.length})`}
                items={invoiceItems}
                side="invoice"
                failedPosition={comparison.stage_a_failed_side === 'invoice' ? comparison.stage_a_failed_position : null}
                onRetry={handleRetry}
                retryingKey={retrying}
              />
            </div>
          )}

          {/* Awaiting method — method picker */}
          {comparison.status === 'awaiting_method' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-6 space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Stage A завершён</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Параметры извлечены. Выберите метод сравнения двух документов.
                </p>
              </div>

              {comparison.stage_a_failed_position != null && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  Внимание: при разборе позиции {comparison.stage_a_failed_side === 'order' ? 'заказа' : 'счёта'} #{comparison.stage_a_failed_position} произошла ошибка
                  ({comparison.stage_a_error ?? 'неизвестная'}). Можно повторить её через кнопку «Повторить» или продолжить как есть.
                </div>
              )}

              <div className="space-y-2">
                {(['fuzzy', 'llm', 'both'] as ComparisonMethod[]).map((m) => (
                  <label key={m} className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
                    <input
                      type="radio"
                      name="method"
                      value={m}
                      checked={chosenMethod === m}
                      onChange={() => setChosenMethod(m)}
                      className="mt-1"
                    />
                    <div>
                      <div className="text-sm font-medium text-slate-900">
                        {m === 'fuzzy' && 'Fuzzy-поиск (Fuse.js + детерминированная валидация)'}
                        {m === 'llm' && 'LLM-сравнение (один вызов на оба документа целиком)'}
                        {m === 'both' && 'Оба метода + сверка'}
                      </div>
                      <div className="text-xs text-slate-500">
                        {m === 'fuzzy' && 'Быстро, без затрат на LLM. Хорош на простых случаях.'}
                        {m === 'llm' && 'Медленнее и дороже, но видит семантику и нестандартные сокращения.'}
                        {m === 'both' && 'Запускает оба метода независимо и подсвечивает расхождения.'}
                      </div>
                    </div>
                  </label>
                ))}
              </div>

              <button
                onClick={handleStartCompare}
                disabled={isStartingCompare}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isStartingCompare ? 'Запуск...' : 'Запустить сравнение'}
              </button>
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

// ─────────────────────────────────────────────────────────────────────────────

interface StageALiveTableProps {
  title: string;
  items: Array<{ position: number; raw_name: string; params_json: { category: string; shape?: string | null; type?: string | null; geometry?: Record<string, unknown> } | null }>;
  side: 'order' | 'invoice';
  failedPosition: number | null;
  onRetry: (side: 'order' | 'invoice', position: number) => void;
  retryingKey: string | null;
}

function StageALiveTable({ title, items, side, failedPosition, onRetry, retryingKey }: StageALiveTableProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      </div>
      <div className="max-h-[480px] overflow-y-auto">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 sticky top-0">
            <tr className="text-left text-slate-500">
              <th className="px-3 py-2 font-medium">№</th>
              <th className="px-3 py-2 font-medium">Наименование</th>
              <th className="px-3 py-2 font-medium">Категория</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((it) => {
              const params = it.params_json;
              const isFailed = failedPosition === it.position || (params?.category === 'other');
              const isProcessed = params != null;
              const key = `${side}-${it.position}`;
              return (
                <tr key={it.position} className={isFailed ? 'bg-red-50' : isProcessed ? 'bg-emerald-50/30' : ''}>
                  <td className="px-3 py-2 text-slate-600 align-top">{it.position}</td>
                  <td className="px-3 py-2 text-slate-800 align-top">{it.raw_name}</td>
                  <td className="px-3 py-2 text-slate-600 align-top">
                    {params ? (
                      <span>
                        {params.category}
                        {params.shape ? `/${params.shape}` : ''}
                        {params.type ? ` · ${params.type}` : ''}
                      </span>
                    ) : (
                      <span className="text-slate-400">в очереди…</span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top">
                    {isFailed && (
                      <button
                        onClick={() => onRetry(side, it.position)}
                        disabled={retryingKey === key}
                        className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-100 disabled:opacity-50"
                      >
                        {retryingKey === key ? '...' : 'Повторить'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
