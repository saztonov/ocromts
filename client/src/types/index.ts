export type MatchStatus = 'matched' | 'partial' | 'order_only' | 'invoice_only';
export type ComparisonStatus = 'pending' | 'parsing' | 'comparing' | 'done' | 'error' | 'cancelled';
export type QuantityStatus = 'exact' | 'within_tolerance' | 'over' | 'under' | 'incompatible_units';

export interface Comparison {
  id: string;
  name: string | null;
  order_filename: string;
  invoice_filename: string;
  invoice_file_type: string;
  status: ComparisonStatus;
  progress: number;
  error_message: string | null;
  cancelled_at: string | null;
  created_at: string;
  summary_json: string | null;
}

export interface ComparisonSummary {
  total_order: number;
  total_invoice: number;
  matched: number;
  unmatched_order: number;
  unmatched_invoice: number;
  critical_mismatches: number;
  warnings: number;
}

export interface OrderItem {
  id: number;
  position: number;
  raw_name: string;
  material_type: string | null;
  gost: string | null;
  params_json: string | null;
  quantity: number;
  unit: string;
}

export interface InvoiceItem extends OrderItem {
  unit_price: number | null;
  total_price: number | null;
}

export interface Discrepancy {
  parameter: string;
  spec_value: string | null;
  invoice_value: string | null;
  severity: 'critical' | 'warning' | 'info';
  comment?: string;
}

export interface ComparisonResult {
  id: number;
  comparison_id: string;
  order_item_id: number | null;
  invoice_item_id: number | null;
  match_status: MatchStatus;
  match_confidence: number | null;
  quantity_status: QuantityStatus | null;
  quantity_diff_pct: number | null;
  conversion_note: string | null;
  discrepancies_json: string | null;
  reasoning: string | null;
}

export interface ComparisonDetail {
  comparison: Comparison;
  orderItems: OrderItem[];
  invoiceItems: InvoiceItem[];
  results: ComparisonResult[];
}
