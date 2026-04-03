interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
}

const sizes: Record<string, string> = {
  sm: 'h-4 w-4 border-2',
  md: 'h-8 w-8 border-[3px]',
  lg: 'h-12 w-12 border-4',
};

export default function Spinner({ size = 'md' }: SpinnerProps) {
  return (
    <div
      className={`animate-spin rounded-full border-slate-200 border-t-indigo-600 ${sizes[size]}`}
      role="status"
      aria-label="Загрузка"
    >
      <span className="sr-only">Загрузка...</span>
    </div>
  );
}
