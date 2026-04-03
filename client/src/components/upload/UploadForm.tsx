import { useState, type FormEvent } from 'react';
import { useFileUpload } from '../../hooks/useFileUpload';
import FileDropzone from './FileDropzone';
import Spinner from '../ui/Spinner';

interface UploadFormProps {
  onSubmit: (orderFile: File, invoiceFile: File, name?: string) => Promise<void>;
}

export default function UploadForm({ onSubmit }: UploadFormProps) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const order = useFileUpload(['.xlsx']);
  const invoice = useFileUpload(['.pdf', '.xlsx']);

  const canSubmit = order.file !== null && invoice.file !== null && !submitting;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!order.file || !invoice.file) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit(order.file, invoice.file, name || undefined);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Произошла ошибка');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="border-b border-slate-100 px-6 py-4">
        <h2 className="text-lg font-semibold text-slate-900">Новая сверка</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Загрузите заказ и счёт для автоматического сравнения
        </p>
      </div>

      <div className="px-6 py-5 space-y-5">
        {/* Name */}
        <div>
          <label htmlFor="comparison-name" className="block text-sm font-medium text-slate-700 mb-1.5">
            Название <span className="text-slate-400 font-normal">(необязательно)</span>
          </label>
          <input
            id="comparison-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например: Заказ #1234 от ООО Стройснаб"
            className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-colors duration-150 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-0"
          />
        </div>

        {/* Dropzones */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <FileDropzone
            label="Заказ поставщику"
            accept=".xlsx"
            file={order.file}
            isDragging={order.isDragging}
            error={order.error}
            onDragOver={order.handleDragOver}
            onDragLeave={order.handleDragLeave}
            onDrop={order.handleDrop}
            onFileSelect={order.handleFileSelect}
            onClear={order.clearFile}
          />
          <FileDropzone
            label="Счёт / Накладная"
            accept=".pdf,.xlsx"
            file={invoice.file}
            isDragging={invoice.isDragging}
            error={invoice.error}
            onDragOver={invoice.handleDragOver}
            onDragLeave={invoice.handleDragLeave}
            onDrop={invoice.handleDrop}
            onFileSelect={invoice.handleFileSelect}
            onClear={invoice.clearFile}
          />
        </div>

        {submitError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
            <p className="text-sm text-red-700">{submitError}</p>
          </div>
        )}
      </div>

      <div className="border-t border-slate-100 px-6 py-4">
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-indigo-600"
        >
          {submitting ? (
            <>
              <Spinner size="sm" />
              <span>Отправка...</span>
            </>
          ) : (
            <>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H4.598a.75.75 0 00-.75.75v3.634a.75.75 0 001.5 0v-2.033l.312.311a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.06-7.846a.75.75 0 00-1.5 0v2.033l-.312-.312a7 7 0 00-11.712 3.139.75.75 0 001.449.389 5.5 5.5 0 019.201-2.466l.312.312H11.38a.75.75 0 100 1.5h3.634a.75.75 0 00.75-.75V3.578z"
                  clipRule="evenodd"
                />
              </svg>
              <span>Сравнить</span>
            </>
          )}
        </button>
      </div>
    </form>
  );
}
