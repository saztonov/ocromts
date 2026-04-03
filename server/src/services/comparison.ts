import path from 'node:path';
import { getDb } from '../db/connection.js';
import { config } from '../config.js';
import { parseExcel } from './excel-parser.js';
import { parsePdf } from './pdf-parser.js';
import { callOpenRouter } from './llm.js';
import { buildComparePrompt, type CompareItemInput } from '../prompts/compare.js';

// ---- Types for the LLM comparison response ---- //

interface ParameterMismatch {
  parameter: string;
  order_value: string;
  invoice_value: string;
  severity: 'critical' | 'warning' | 'info';
}

interface QuantityComparison {
  order_qty: number;
  order_unit: string;
  invoice_qty: number;
  invoice_unit: string;
  converted_invoice_qty?: number;
  converted_unit?: string;
  difference_pct: number;
  status: 'exact' | 'within_tolerance' | 'over' | 'under' | 'incompatible_units';
  conversion_note?: string;
}

interface MatchedItem {
  order_row: number;
  invoice_row: number;
  order_name: string;
  invoice_name: string;
  normalized_name?: string;
  match_confidence: number;
  match_reasoning: string;
  parameter_mismatches: ParameterMismatch[];
  quantity_comparison: QuantityComparison;
}

interface UnmatchedOrderItem {
  order_row: number;
  order_name: string;
  reason: string;
}

interface UnmatchedInvoiceItem {
  invoice_row: number;
  invoice_name: string;
  reason: string;
}

interface ComparisonSummary {
  total_order: number;
  total_invoice: number;
  matched: number;
  unmatched_order: number;
  unmatched_invoice: number;
  critical_mismatches: number;
  warnings: number;
}

interface ComparisonLLMResult {
  matched_items: MatchedItem[];
  unmatched_order: UnmatchedOrderItem[];
  unmatched_invoice: UnmatchedInvoiceItem[];
  summary: ComparisonSummary;
}

// ---- DB row types ---- //

interface ComparisonRow {
  id: string;
  name: string | null;
  order_filename: string;
  invoice_filename: string;
  invoice_file_type: string;
  status: string;
  progress: number;
  error_message: string | null;
  cancelled_at: string | null;
  created_at: string;
  summary_json: string | null;
}

interface InsertedItemRow {
  id: number;
  position: number;
}

// ---- Cancellation & progress infrastructure ---- //

/** In-memory map of active comparison AbortControllers */
const activeControllers = new Map<string, AbortController>();

/** Maximum time for the entire comparison pipeline */
const PIPELINE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

class CancellationError extends Error {
  constructor(message = 'Сверка отменена пользователем') {
    super(message);
    this.name = 'CancellationError';
  }
}

/** Update both status and progress in one DB call */
function updateProgress(comparisonId: string, status: string, progress: number): void {
  getDb().prepare('UPDATE comparisons SET status = ?, progress = ? WHERE id = ?')
    .run(status, progress, comparisonId);
}

/** Check if comparison was cancelled; throw CancellationError if so */
function checkCancelled(comparisonId: string): void {
  const row = getDb().prepare('SELECT cancelled_at FROM comparisons WHERE id = ?')
    .get(comparisonId) as { cancelled_at: string | null } | undefined;
  if (row?.cancelled_at) {
    throw new CancellationError();
  }
}

/**
 * Cancel a running comparison. Sets DB flag and aborts in-flight requests.
 * Returns true if the comparison was successfully cancelled.
 */
export function cancelComparison(comparisonId: string): boolean {
  const result = getDb().prepare(
    "UPDATE comparisons SET cancelled_at = datetime('now'), status = 'cancelled', progress = 0, error_message = 'Отменено пользователем' WHERE id = ? AND status NOT IN ('done', 'error', 'cancelled')"
  ).run(comparisonId);

  const controller = activeControllers.get(comparisonId);
  if (controller) {
    controller.abort();
  }

  return result.changes > 0;
}

// ---- Main orchestration ---- //

/**
 * Runs the full comparison pipeline for a given comparison ID.
 * This function is called asynchronously after the upload endpoint returns.
 *
 * Flow:
 * 1. Parse order file (Excel)
 * 2. Parse invoice file (PDF or Excel)
 * 3. Save parsed items to DB
 * 4. Send both item lists to LLM for normalization + comparison
 * 5. Save comparison results to DB
 *
 * Supports: progress tracking (0-100%), cancellation, and pipeline timeout.
 */
export async function startComparison(comparisonId: string): Promise<void> {
  const db = getDb();
  const controller = new AbortController();
  activeControllers.set(comparisonId, controller);

  // Pipeline timeout — abort if total time exceeds limit
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, PIPELINE_TIMEOUT_MS);

  try {
    // ---------- Step 1: Update status ----------
    updateProgress(comparisonId, 'parsing', 5);

    const comparison = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(comparisonId) as ComparisonRow | undefined;
    if (!comparison) {
      throw new Error(`Comparison ${comparisonId} not found`);
    }

    const uploadsDir = path.join(config.UPLOADS_DIR, comparisonId);
    const orderFilePath = path.join(uploadsDir, comparison.order_filename);
    const invoiceFilePath = path.join(uploadsDir, comparison.invoice_filename);

    // ---------- Step 2: Parse order (always Excel) ----------
    checkCancelled(comparisonId);
    console.log(`[comparison] Parsing order file: ${comparison.order_filename}`);
    const orderItems = parseExcel(orderFilePath);
    console.log(`[comparison] Parsed ${orderItems.length} order items`);

    if (orderItems.length === 0) {
      throw new Error('No items found in order file. Check the Excel format.');
    }

    updateProgress(comparisonId, 'parsing', 15);

    // ---------- Step 3: Parse invoice ----------
    checkCancelled(comparisonId);
    console.log(`[comparison] Parsing invoice file: ${comparison.invoice_filename} (${comparison.invoice_file_type})`);
    let invoiceItems;
    if (comparison.invoice_file_type === 'pdf') {
      invoiceItems = await parsePdf(invoiceFilePath, controller.signal);
    } else {
      invoiceItems = parseExcel(invoiceFilePath);
    }
    console.log(`[comparison] Parsed ${invoiceItems.length} invoice items`);

    if (invoiceItems.length === 0) {
      throw new Error('No items found in invoice file. Check the file format.');
    }

    updateProgress(comparisonId, 'parsing', 35);

    // ---------- Step 4: Save parsed items to DB ----------
    checkCancelled(comparisonId);

    const insertOrderItem = db.prepare(`
      INSERT INTO order_items (comparison_id, position, raw_name, quantity, unit)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertInvoiceItem = db.prepare(`
      INSERT INTO invoice_items (comparison_id, position, raw_name, quantity, unit, unit_price, total_price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Map position -> inserted row ID for later linking
    const orderPositionToId = new Map<number, number>();
    const invoicePositionToId = new Map<number, number>();

    const insertOrderItems = db.transaction(() => {
      for (const item of orderItems) {
        const result = insertOrderItem.run(
          comparisonId,
          item.position,
          item.rawName,
          item.quantity,
          item.unit
        );
        orderPositionToId.set(item.position, Number(result.lastInsertRowid));
      }
    });
    insertOrderItems();

    const insertInvoiceItems = db.transaction(() => {
      for (const item of invoiceItems) {
        const result = insertInvoiceItem.run(
          comparisonId,
          item.position,
          item.rawName,
          item.quantity,
          item.unit,
          item.unitPrice ?? null,
          item.totalPrice ?? null
        );
        invoicePositionToId.set(item.position, Number(result.lastInsertRowid));
      }
    });
    insertInvoiceItems();

    updateProgress(comparisonId, 'comparing', 40);

    // ---------- Step 5: LLM comparison ----------
    checkCancelled(comparisonId);

    const orderForPrompt: CompareItemInput[] = orderItems.map((item) => ({
      position: item.position,
      rawName: item.rawName,
      unit: item.unit,
      quantity: item.quantity,
    }));

    const invoiceForPrompt: CompareItemInput[] = invoiceItems.map((item) => ({
      position: item.position,
      rawName: item.rawName,
      unit: item.unit,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
    }));

    const { systemPrompt, userMessage } = buildComparePrompt(orderForPrompt, invoiceForPrompt);

    console.log(`[comparison] Sending ${orderItems.length} order + ${invoiceItems.length} invoice items to LLM`);

    updateProgress(comparisonId, 'comparing', 45);

    const llmResponse = await callOpenRouter({
      model: config.OPENROUTER_MODEL_COMPARE,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.1,
      maxTokens: 64000,
      responseFormat: { type: 'json_object' },
      signal: controller.signal,
    });

    updateProgress(comparisonId, 'comparing', 90);

    checkCancelled(comparisonId);

    const comparisonResult = parseJsonResponse(llmResponse);

    // ---------- Step 6: Save results ----------
    const insertResult = db.prepare(`
      INSERT INTO comparison_results (
        comparison_id, order_item_id, invoice_item_id,
        match_status, match_confidence,
        quantity_status, quantity_diff_pct, conversion_note,
        discrepancies_json, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const saveResults = db.transaction(() => {
      // Save matched items
      for (const match of comparisonResult.matched_items ?? []) {
        const orderItemId = orderPositionToId.get(match.order_row) ?? null;
        const invoiceItemId = invoicePositionToId.get(match.invoice_row) ?? null;

        const discrepancies = match.parameter_mismatches?.length
          ? JSON.stringify(match.parameter_mismatches)
          : null;

        insertResult.run(
          comparisonId,
          orderItemId,
          invoiceItemId,
          'matched',
          match.match_confidence,
          match.quantity_comparison?.status ?? null,
          match.quantity_comparison?.difference_pct ?? null,
          match.quantity_comparison?.conversion_note ?? null,
          discrepancies,
          match.match_reasoning
        );
      }

      // Save unmatched order items
      for (const item of comparisonResult.unmatched_order ?? []) {
        const orderItemId = orderPositionToId.get(item.order_row) ?? null;

        insertResult.run(
          comparisonId,
          orderItemId,
          null,
          'unmatched_order',
          null,
          null,
          null,
          null,
          null,
          item.reason
        );
      }

      // Save unmatched invoice items
      for (const item of comparisonResult.unmatched_invoice ?? []) {
        const invoiceItemId = invoicePositionToId.get(item.invoice_row) ?? null;

        insertResult.run(
          comparisonId,
          null,
          invoiceItemId,
          'unmatched_invoice',
          null,
          null,
          null,
          null,
          null,
          item.reason
        );
      }
    });
    saveResults();

    updateProgress(comparisonId, 'done', 95);

    // ---------- Step 7: Save summary and mark done ----------
    db.prepare('UPDATE comparisons SET summary_json = ?, status = ?, progress = ? WHERE id = ?').run(
      JSON.stringify(comparisonResult.summary ?? {}),
      'done',
      100,
      comparisonId
    );

    console.log(`[comparison] Completed comparison ${comparisonId}`);

  } catch (err) {
    if (err instanceof CancellationError) {
      console.log(`[comparison] Cancelled: ${comparisonId}`);
    } else {
      const cancelledRow = getDb().prepare('SELECT cancelled_at FROM comparisons WHERE id = ?').get(comparisonId) as { cancelled_at: string | null } | undefined;
      const isTimeout = err instanceof Error && err.name === 'AbortError' && !cancelledRow?.cancelled_at;
      const message = isTimeout
        ? 'Превышено максимальное время обработки (10 мин)'
        : err instanceof Error ? err.message : String(err);
      console.error(`[comparison] Error for ${comparisonId}:`, message);

      db.prepare('UPDATE comparisons SET status = ?, error_message = ? WHERE id = ?').run(
        'error',
        message,
        comparisonId
      );
    }
  } finally {
    clearTimeout(timeoutHandle);
    activeControllers.delete(comparisonId);
  }
}

/**
 * Parses a JSON response that may be wrapped in markdown code fences.
 */
function parseJsonResponse(text: string): ComparisonLLMResult {
  const cleaned = stripMarkdownFences(text);

  try {
    return JSON.parse(cleaned) as ComparisonLLMResult;
  } catch {
    throw new Error(`Failed to parse LLM comparison response as JSON: ${cleaned.slice(0, 300)}`);
  }
}

/**
 * Strips markdown code fences from LLM response.
 * Handles both closed (```json ... ```) and unclosed (```json ... EOF) fences.
 */
function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();

  // Try closed fence first (greedy to match the last closing ```)
  const closedFence = cleaned.match(/^```(?:json)?\s*\n([\s\S]*)\n\s*```\s*$/);
  if (closedFence) {
    return closedFence[1]!.trim();
  }

  // Unclosed fence (response truncated — no closing ```)
  const openFence = cleaned.match(/^```(?:json)?\s*\n([\s\S]*)$/);
  if (openFence) {
    return openFence[1]!.trim();
  }

  return cleaned;
}
