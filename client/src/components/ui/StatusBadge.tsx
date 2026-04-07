import type { MatchStatus, ComparisonStatus } from '../../types';

type Status = MatchStatus | ComparisonStatus;

const config: Record<Status, { label: string; classes: string }> = {
  matched: {
    label: 'Совпадение',
    classes: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  },
  partial: {
    label: 'Частичное',
    classes: 'bg-amber-50 text-amber-700 border border-amber-200',
  },
  mismatch: {
    label: 'Расхождение',
    classes: 'bg-red-50 text-red-700 border border-red-200',
  },
  unmatched_order: {
    label: 'Нет в счёте',
    classes: 'bg-red-50 text-red-700 border border-red-200',
  },
  unmatched_invoice: {
    label: 'Лишнее в счёте',
    classes: 'bg-sky-50 text-sky-700 border border-sky-200',
  },
  // Legacy aliases
  order_only: {
    label: 'Нет в счёте',
    classes: 'bg-red-50 text-red-700 border border-red-200',
  },
  invoice_only: {
    label: 'Лишнее в счёте',
    classes: 'bg-sky-50 text-sky-700 border border-sky-200',
  },
  done: {
    label: 'Готово',
    classes: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  },
  parsing: {
    label: 'Анализ...',
    classes: 'bg-amber-50 text-amber-700 border border-amber-200',
  },
  comparing: {
    label: 'Сравнение...',
    classes: 'bg-amber-50 text-amber-700 border border-amber-200',
  },
  extracting: {
    label: 'Извлечение...',
    classes: 'bg-amber-50 text-amber-700 border border-amber-200',
  },
  awaiting_method: {
    label: 'Выбор метода',
    classes: 'bg-sky-50 text-sky-700 border border-sky-200',
  },
  error: {
    label: 'Ошибка',
    classes: 'bg-red-50 text-red-700 border border-red-200',
  },
  pending: {
    label: 'В очереди',
    classes: 'bg-slate-50 text-slate-600 border border-slate-200',
  },
  cancelled: {
    label: 'Отменено',
    classes: 'bg-slate-50 text-slate-600 border border-slate-200',
  },
};

interface StatusBadgeProps {
  status: Status;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const { label, classes } = config[status] ?? {
    label: status,
    classes: 'bg-slate-50 text-slate-600 border border-slate-200',
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${classes}`}
    >
      {label}
    </span>
  );
}
