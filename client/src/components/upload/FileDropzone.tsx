import { useRef, type DragEvent, type ChangeEvent } from 'react';

interface FileDropzoneProps {
  label: string;
  accept: string;
  file: File | null;
  isDragging: boolean;
  error?: string | null;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  onFileSelect: (e: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export default function FileDropzone({
  label,
  accept,
  file,
  isDragging,
  error,
  onDragOver,
  onDragLeave,
  onDrop,
  onFileSelect,
  onClear,
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    inputRef.current?.click();
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-slate-700">{label}</span>

      {file ? (
        /* ---- File selected state ---- */
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 min-h-[200px]">
          {/* File icon */}
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              className="h-5 w-5 text-indigo-600"
              aria-hidden="true"
            >
              <path
                d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"
                className="stroke-current"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path d="M14 2v6h6" className="stroke-current" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-900 truncate">{file.name}</p>
            <p className="text-xs text-slate-500">{formatSize(file.size)}</p>
          </div>

          <button
            type="button"
            onClick={onClear}
            className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            aria-label="Удалить файл"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 011.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      ) : (
        /* ---- Dropzone state ---- */
        <div
          role="button"
          tabIndex={0}
          onClick={handleClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleClick();
            }
          }}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`flex min-h-[200px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
            isDragging
              ? 'border-indigo-400 bg-indigo-50'
              : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50'
          }`}
        >
          {/* Upload icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 40 40"
            fill="none"
            className={`mb-3 h-10 w-10 transition-colors duration-150 ${
              isDragging ? 'text-indigo-500' : 'text-slate-400'
            }`}
            aria-hidden="true"
          >
            <rect x="6" y="8" width="28" height="26" rx="3" className="stroke-current" strokeWidth="1.5" fill="none" />
            <path
              d="M20 26V16m0 0l-4 4m4-4l4 4"
              className="stroke-current"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>

          <p className="text-sm font-medium text-slate-700">
            Перетащите файл сюда или <span className="text-indigo-600">выберите</span>
          </p>
          <p className="mt-1 text-xs text-slate-500">Формат: {accept}</p>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={onFileSelect}
        className="hidden"
        tabIndex={-1}
      />
    </div>
  );
}
