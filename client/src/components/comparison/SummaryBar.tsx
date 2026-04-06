import type { ComparisonSummary } from '../../types';

interface SummaryBarProps {
  summary: ComparisonSummary;
}

interface CardDef {
  label: string;
  value: number;
  color: string;
  stripColor: string;
}

export default function SummaryBar({ summary }: SummaryBarProps) {
  const cards: CardDef[] = [
    {
      label: 'Совпало',
      value: summary.matched,
      color: 'text-emerald-700',
      stripColor: 'bg-emerald-500',
    },
    {
      label: 'Частичные',
      value: summary.warnings,
      color: 'text-amber-700',
      stripColor: 'bg-amber-500',
    },
    {
      label: 'Расхождения',
      value: summary.critical_mismatches,
      color: 'text-red-700',
      stripColor: 'bg-red-500',
    },
    {
      label: 'Нет в счёте',
      value: summary.unmatched_order,
      color: 'text-red-700',
      stripColor: 'bg-red-500',
    },
    {
      label: 'Лишние в счёте',
      value: summary.unmatched_invoice,
      color: 'text-sky-700',
      stripColor: 'bg-sky-500',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((card) => (
        <div
          key={card.label}
          className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
        >
          <div className={`h-1 ${card.stripColor}`} />
          <div className="p-4">
            <p className={`text-2xl font-bold ${card.color}`}>{card.value}</p>
            <p className="mt-1 text-sm text-slate-500">{card.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
