interface ProgressBarProps {
  progress: number;
}

export default function ProgressBar({ progress }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, progress));

  return (
    <div className="w-full">
      <div className="flex justify-between text-sm text-slate-600 mb-1">
        <span>Прогресс</span>
        <span>{clamped}%</span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-indigo-600 transition-all duration-500 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
