import type {
  ComparisonResult,
  OrderItem,
  InvoiceItem,
  MatchStatus,
  ComparisonMethod,
} from '../../types';
import ComparisonTableSingle from './ComparisonTableSingle';
import ComparisonTableBoth from './ComparisonTableBoth';

interface ComparisonTableProps {
  results: ComparisonResult[];
  orderItems: OrderItem[];
  invoiceItems: InvoiceItem[];
  filter: MatchStatus | 'all';
  comparisonMethod: ComparisonMethod | null;
}

export default function ComparisonTable({
  results,
  orderItems,
  invoiceItems,
  filter,
  comparisonMethod,
}: ComparisonTableProps) {
  if (comparisonMethod === 'both') {
    return (
      <ComparisonTableBoth
        results={results}
        orderItems={orderItems}
        invoiceItems={invoiceItems}
        filter={filter}
      />
    );
  }
  return (
    <ComparisonTableSingle
      results={results}
      orderItems={orderItems}
      invoiceItems={invoiceItems}
      filter={filter}
    />
  );
}
