import { useState, useCallback, type DragEvent, type ChangeEvent } from 'react';

interface UseFileUploadReturn {
  file: File | null;
  isDragging: boolean;
  error: string | null;
  handleDragOver: (e: DragEvent<HTMLElement>) => void;
  handleDragLeave: (e: DragEvent<HTMLElement>) => void;
  handleDrop: (e: DragEvent<HTMLElement>) => void;
  handleFileSelect: (e: ChangeEvent<HTMLInputElement>) => void;
  clearFile: () => void;
}

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx).toLowerCase() : '';
}

export function useFileUpload(acceptedTypes: string[]): UseFileUploadReturn {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validate = useCallback(
    (f: File): boolean => {
      const ext = getExtension(f.name);
      const accepted = acceptedTypes.map((t) => t.toLowerCase().trim());
      if (!accepted.includes(ext)) {
        setError(`Неподдерживаемый формат. Допустимые: ${acceptedTypes.join(', ')}`);
        return false;
      }
      setError(null);
      return true;
    },
    [acceptedTypes],
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const dropped = e.dataTransfer.files[0];
      if (dropped && validate(dropped)) {
        setFile(dropped);
      }
    },
    [validate],
  );

  const handleFileSelect = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (selected && validate(selected)) {
        setFile(selected);
      }
      // Reset input so re-selecting same file triggers change
      e.target.value = '';
    },
    [validate],
  );

  const clearFile = useCallback(() => {
    setFile(null);
    setError(null);
  }, []);

  return {
    file,
    isDragging,
    error,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileSelect,
    clearFile,
  };
}
