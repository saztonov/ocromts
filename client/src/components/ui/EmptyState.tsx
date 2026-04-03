import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
}

export default function EmptyState({ title, description, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      {icon ? (
        <div className="mb-4 text-slate-300">{icon}</div>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 48 48"
          fill="none"
          className="mb-4 h-12 w-12 text-slate-300"
          aria-hidden="true"
        >
          <rect x="8" y="6" width="32" height="36" rx="4" className="stroke-current" strokeWidth="2" fill="none" />
          <line x1="16" y1="16" x2="32" y2="16" className="stroke-current" strokeWidth="2" strokeLinecap="round" />
          <line x1="16" y1="22" x2="28" y2="22" className="stroke-current" strokeWidth="2" strokeLinecap="round" />
          <line x1="16" y1="28" x2="24" y2="28" className="stroke-current" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
      <h3 className="text-sm font-medium text-slate-900">{title}</h3>
      {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
    </div>
  );
}
