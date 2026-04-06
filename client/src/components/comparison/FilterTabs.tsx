import type { MatchStatus } from '../../types';

type FilterValue = MatchStatus | 'all';

interface FilterTabsProps {
  activeFilter: FilterValue;
  onFilterChange: (filter: FilterValue) => void;
  counts: Record<string, number>;
}

interface Tab {
  value: FilterValue;
  label: string;
}

const tabs: Tab[] = [
  { value: 'all', label: 'Все' },
  { value: 'matched', label: 'Совпадения' },
  { value: 'partial', label: 'Частичные' },
  { value: 'mismatch', label: 'Расхождения' },
  { value: 'unmatched_order', label: 'Нет в счёте' },
  { value: 'unmatched_invoice', label: 'Лишние' },
];

export default function FilterTabs({ activeFilter, onFilterChange, counts }: FilterTabsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const isActive = activeFilter === tab.value;
        const count = counts[tab.value] ?? 0;

        return (
          <button
            key={tab.value}
            type="button"
            onClick={() => onFilterChange(tab.value)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
              isActive
                ? 'bg-slate-900 text-white shadow-sm'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>{tab.label}</span>
            <span
              className={`inline-flex min-w-[20px] items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-medium ${
                isActive
                  ? 'bg-white/20 text-white'
                  : 'bg-slate-100 text-slate-500'
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
