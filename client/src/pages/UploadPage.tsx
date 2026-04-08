import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createComparison, getComparisons, deleteComparison } from '../api/client';
import UploadForm from '../components/upload/UploadForm';
import HistoryTable from '../components/upload/HistoryTable';
import Spinner from '../components/ui/Spinner';

export default function UploadPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: comparisons, isLoading } = useQuery({
    queryKey: ['comparisons'],
    queryFn: getComparisons,
  });

  const handleSubmit = async (
    orderFile: File,
    invoiceFile: File,
    name?: string,
    extractBatchConcurrency?: 1 | 3,
    userPrompt?: string,
  ) => {
    const { id } = await createComparison(orderFile, invoiceFile, name, extractBatchConcurrency, userPrompt);
    await queryClient.invalidateQueries({ queryKey: ['comparisons'] });
    navigate(`/comparisons/${id}`);
  };

  const handleDelete = async (id: string) => {
    await deleteComparison(id);
    await queryClient.invalidateQueries({ queryKey: ['comparisons'] });
  };

  return (
    <div className="space-y-8">
      <UploadForm onSubmit={handleSubmit} />

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : (
        <HistoryTable
          comparisons={comparisons ?? []}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
