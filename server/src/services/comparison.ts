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

/** Maximum time for the entire comparison pipeline (from config) */
const PIPELINE_TIMEOUT_MS = config.PIPELINE_TIMEOUT_MS;

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

    // ---------- Step 5: LLM comparison (batched) ----------
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

    const BATCH_SIZE = 15;
    const orderBatches: CompareItemInput[][] = [];
    for (let i = 0; i < orderForPrompt.length; i += BATCH_SIZE) {
      orderBatches.push(orderForPrompt.slice(i, i + BATCH_SIZE));
    }

    console.log(
      `[comparison] Splitting ${orderItems.length} order items into ${orderBatches.length} batch(es) ` +
      `(batch size: ${BATCH_SIZE}) against ${invoiceItems.length} invoice items`
    );

    updateProgress(comparisonId, 'comparing', 45);

    // Accumulate results from all batches
    const mergedResult: ComparisonLLMResult = {
      matched_items: [],
      unmatched_order: [],
      unmatched_invoice: [],
      summary: { total_order: 0, total_invoice: 0, matched: 0, unmatched_order: 0, unmatched_invoice: 0, critical_mismatches: 0, warnings: 0 },
    };

    // Track which invoice positions have been matched so far
    const matchedInvoicePositions = new Set<number>();

    for (let batchIdx = 0; batchIdx < orderBatches.length; batchIdx++) {
      checkCancelled(comparisonId);

      const batch = orderBatches[batchIdx]!;

      // Filter out already-matched invoice items for subsequent batches
      const availableInvoice = batchIdx === 0
        ? invoiceForPrompt
        : invoiceForPrompt.filter((item) => !matchedInvoicePositions.has(item.position));

      console.log(
        `[comparison] Batch ${batchIdx + 1}/${orderBatches.length}: ` +
        `${batch.length} order items vs ${availableInvoice.length} invoice items`
      );

      const { systemPrompt, userMessage } = buildComparePrompt(batch, availableInvoice);

      const llmResponse = await callOpenRouter({
        model: config.OPENROUTER_MODEL_COMPARE,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1,
        responseFormat: { type: 'json_object' },
        signal: controller.signal,
      });

      const batchResult = parseJsonResponse(llmResponse);

      // Merge matched items and track matched invoice positions
      for (const match of batchResult.matched_items ?? []) {
        mergedResult.matched_items.push(match);
        matchedInvoicePositions.add(match.invoice_row);
      }

      // Merge unmatched order items
      for (const item of batchResult.unmatched_order ?? []) {
        mergedResult.unmatched_order.push(item);
      }

      // Progress: 45% → 90% spread across batches
      const batchProgress = 45 + Math.round(((batchIdx + 1) / orderBatches.length) * 45);
      updateProgress(comparisonId, 'comparing', batchProgress);

      console.log(
        `[comparison] Batch ${batchIdx + 1} done: ${batchResult.matched_items?.length ?? 0} matched, ` +
        `${batchResult.unmatched_order?.length ?? 0} unmatched order`
      );
    }

    checkCancelled(comparisonId);

    // Determine unmatched invoice items (not matched in any batch)
    for (const item of invoiceForPrompt) {
      if (!matchedInvoicePositions.has(item.position)) {
        mergedResult.unmatched_invoice.push({
          invoice_row: item.position,
          invoice_name: item.rawName,
          reason: 'Не найдено соответствие в заказе',
        });
      }
    }

    // Rebuild summary from merged data
    mergedResult.summary = {
      total_order: orderForPrompt.length,
      total_invoice: invoiceForPrompt.length,
      matched: mergedResult.matched_items.length,
      unmatched_order: mergedResult.unmatched_order.length,
      unmatched_invoice: mergedResult.unmatched_invoice.length,
      critical_mismatches: mergedResult.matched_items.reduce(
        (acc, m) => acc + (m.parameter_mismatches?.filter((p) => p.severity === 'critical').length ?? 0), 0
      ),
      warnings: mergedResult.matched_items.reduce(
        (acc, m) => acc + (m.parameter_mismatches?.filter((p) => p.severity === 'warning').length ?? 0), 0
      ),
    };

    console.log(
      `[comparison] All batches done: ${mergedResult.summary.matched} matched, ` +
      `${mergedResult.summary.unmatched_order} unmatched order, ` +
      `${mergedResult.summary.unmatched_invoice} unmatched invoice`
    );

    const comparisonResult = mergedResult;

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
        ? `Превышено максимальное время обработки (${Math.round(PIPELINE_TIMEOUT_MS / 60000)} мин)`
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
