export type MatchStatus =
  | 'matched'
  | 'partial'
  | 'mismatch'
  | 'unmatched_order'
  | 'unmatched_invoice'
  // Legacy aliases (kept for backwards compatibility with old DB rows / filters)
  | 'order_only'
  | 'invoice_only';
export type ComparisonStatus =
  | 'pending'
  | 'parsing'
  | 'extracting'
  | 'awaiting_method'
  | 'comparing'
  | 'done'
  | 'error'
  | 'cancelled';

export type ComparisonMethod = 'fuzzy' | 'llm' | 'both';
export type QuantityStatus = 'exact' | 'within_tolerance' | 'over' | 'under' | 'incompatible_units';

/** Структурированные параметры одной позиции (Stage A: parameter-extractor). */
export interface ItemParams {
  position?: number;
  category: string;
  type?: string | null;
  shape?: 'round' | 'rectangular' | 'square' | null;
  geometry?: Record<string, number | string | null>;
  material?: Record<string, number | string | null>;
  standards?: Record<string, number | string | null>;
  extra?: Record<string, number | string | null>;
}

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
  comparison_method: ComparisonMethod | null;
  stage_a_total: number;
  stage_a_done: number;
  stage_a_failed_position: number | null;
  stage_a_failed_side: 'order' | 'invoice' | null;
  stage_a_error: string | null;
  stage_a_completed_at: string | null;
  user_prompt: string | null;
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
  /** Server pre-parses params_json into ItemParams object (see routes/comparisons.ts). */
  params_json: ItemParams | null;
  quantity: number;
  unit: string;
  comment?: string | null;
  comment_has_units?: number;
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

export interface SplitEntry {
  group: string | null;
  invoicePosition: number;
  qty: number | null;
}

export interface SplitInfo {
  invoicePositions: number[];
  totalInvoiceQty: number;
  invoiceUnit: string;
  byGroup: SplitEntry[] | null;
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
  method: string;
  split_json?: SplitInfo | null;
}

export interface ComparisonDetail {
  comparison: Comparison;
  orderItems: OrderItem[];
  invoiceItems: InvoiceItem[];
  results: ComparisonResult[];
}
