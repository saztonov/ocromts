/**
 * Оркестрация пайплайна сравнения.
 *
 * Stage A (extracting) — построчная классификация позиций через LLM, запись в БД
 *   после каждой строки. По завершении статус → 'awaiting_method'.
 *
 * Затем пользователь выбирает метод сравнения через POST /api/comparisons/:id/compare.
 * После этого запускается runStageB (comparing) с одним из методов:
 *   - 'fuzzy' — Fuse.js + детерминированный валидатор
 *   - 'llm'   — один LLM-вызов на оба документа целиком
 *   - 'both'  — оба метода независимо, два набора результатов с разным `method`
 */

import path from 'node:path';
import { getDb } from '../db/connection.js';
import { config } from '../config.js';
import { parseExcel } from './excel-parser.js';
import { parsePdf } from './pdf-parser.js';
import { extractParameters, extractSingleParameter } from './parameter-extractor.js';
import type { ExtractedItem, RawItemForExtraction } from '../prompts/extract-params.js';
import { matchFuzzy } from './fuzzy-matcher.js';
import { matchLlm, type MatchPair } from './llm-document-comparator.js';
import { compareQuantities } from './unit-converter.js';
import { dumpJson } from '../utils/llm-dump.js';

export type ComparisonMethod = 'fuzzy' | 'llm' | 'both';

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
  comparison_method: string | null;
  stage_a_total: number;
  stage_a_done: number;
  stage_a_failed_position: number | null;
  stage_a_failed_side: string | null;
  stage_a_error: string | null;
  stage_a_completed_at: string | null;
  user_prompt: string | null;
}

// ---- Cancellation infrastructure ---- //

const activeControllers = new Map<string, AbortController>();

class CancellationError extends Error {
  constructor(message = 'Сверка отменена пользователем') {
    super(message);
    this.name = 'CancellationError';
  }
}

function updateProgress(comparisonId: string, status: string, progress: number): void {
  getDb().prepare('UPDATE comparisons SET status = ?, progress = ? WHERE id = ?')
    .run(status, progress, comparisonId);
}

function checkCancelled(comparisonId: string): void {
  const row = getDb().prepare('SELECT cancelled_at FROM comparisons WHERE id = ?')
    .get(comparisonId) as { cancelled_at: string | null } | undefined;
  if (row?.cancelled_at) {
    throw new CancellationError();
  }
}

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

// ─────────────────────────────────────────────────────────────────────────────
// STAGE A — построчное извлечение параметров

/**
 * Парсит файлы, сохраняет сырые позиции в order_items/invoice_items,
 * затем построчно прогоняет каждую позицию через LLM (Stage A).
 * После каждой позиции обновляется params_json в соответствующей строке БД
 * и инкрементируется counters.stage_a_done.
 *
 * По завершении статус → 'awaiting_method'. Пользователь должен явно выбрать
 * метод сравнения через POST /api/comparisons/:id/compare.
 */
export async function runStageA(comparisonId: string, options?: { batchConcurrency?: number }): Promise<void> {
  const db = getDb();
  const controller = new AbortController();
  activeControllers.set(comparisonId, controller);

  // Stage A чекпоинтит каждую позицию в БД, поэтому хард-таймаут не нужен —
  // прервать может только пользователь через cancelComparison.
  try {
    updateProgress(comparisonId, 'parsing', 5);

    const comparison = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(comparisonId) as ComparisonRow | undefined;
    if (!comparison) throw new Error(`Comparison ${comparisonId} not found`);

    dumpJson(comparisonId, '00_meta.json', {
      comparisonId,
      name: comparison.name,
      order_filename: comparison.order_filename,
      invoice_filename: comparison.invoice_filename,
      invoice_file_type: comparison.invoice_file_type,
      created_at: comparison.created_at,
      stage_a_started_at: new Date().toISOString(),
    });

    const uploadsDir = path.join(config.UPLOADS_DIR, comparisonId);
    const orderFilePath = path.join(uploadsDir, comparison.order_filename);
    const invoiceFilePath = path.join(uploadsDir, comparison.invoice_filename);

    // ---------- Парсинг файлов ----------
    checkCancelled(comparisonId);
    console.log(`[comparison] ${comparisonId} parsing order: ${comparison.order_filename}`);
    const orderItems = parseExcel(orderFilePath);
    console.log(`[comparison] ${comparisonId} parsed ${orderItems.length} order items`);
    if (orderItems.length === 0) throw new Error('No items found in order file. Check the Excel format.');

    updateProgress(comparisonId, 'parsing', 15);

    checkCancelled(comparisonId);
    console.log(`[comparison] ${comparisonId} parsing invoice: ${comparison.invoice_filename} (${comparison.invoice_file_type})`);
    const invoiceItems = comparison.invoice_file_type === 'pdf'
      ? await parsePdf(invoiceFilePath, controller.signal, comparisonId)
      : parseExcel(invoiceFilePath);
    console.log(`[comparison] ${comparisonId} parsed ${invoiceItems.length} invoice items`);
    if (invoiceItems.length === 0) throw new Error('No items found in invoice file. Check the file format.');

    updateProgress(comparisonId, 'parsing', 25);

    // ---------- Запись сырых позиций в БД ----------
    checkCancelled(comparisonId);

    const insertOrderItem = db.prepare(`
      INSERT INTO order_items (comparison_id, position, raw_name, quantity, unit, comment, comment_has_units)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertInvoiceItem = db.prepare(`
      INSERT INTO invoice_items (comparison_id, position, raw_name, quantity, unit, unit_price, total_price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const orderPositionToId = new Map<number, number>();
    const invoicePositionToId = new Map<number, number>();

    db.transaction(() => {
      for (const it of orderItems) {
        const r = insertOrderItem.run(
          comparisonId,
          it.position,
          it.rawName,
          it.quantity,
          it.unit,
          it.comment ?? null,
          it.commentHasUnits ? 1 : 0
        );
        orderPositionToId.set(it.position, Number(r.lastInsertRowid));
      }
      for (const it of invoiceItems) {
        const r = insertInvoiceItem.run(
          comparisonId, it.position, it.rawName, it.quantity, it.unit,
          it.unitPrice ?? null, it.totalPrice ?? null
        );
        invoicePositionToId.set(it.position, Number(r.lastInsertRowid));
      }
      // Инициализируем счётчики Stage A
      db.prepare('UPDATE comparisons SET stage_a_total = ?, stage_a_done = 0 WHERE id = ?')
        .run(orderItems.length + invoiceItems.length, comparisonId);
    })();

    // ---------- Stage A: построчное извлечение ----------
    checkCancelled(comparisonId);
    updateProgress(comparisonId, 'extracting', 30);

    const orderRaw: RawItemForExtraction[] = orderItems.map((it) => ({
      position: it.position, rawName: it.rawName, unit: it.unit, quantity: it.quantity,
    }));
    const invoiceRaw: RawItemForExtraction[] = invoiceItems.map((it) => ({
      position: it.position, rawName: it.rawName, unit: it.unit, quantity: it.quantity,
    }));

    const orderTask = extractParameters(orderRaw, {
      comparisonId,
      side: 'order',
      signal: controller.signal,
      batchConcurrency: options?.batchConcurrency,
      onItemDone: (item) => {
        persistOneItem(comparisonId, 'order_items', orderPositionToId, item);
        bumpStageADone(comparisonId);
      },
      onItemFailed: (item, error) => {
        persistOneItem(comparisonId, 'order_items', orderPositionToId, item);
        bumpStageADone(comparisonId);
        markStageAFailure(comparisonId, 'order', item.position, error.message);
      },
    });

    const invoiceTask = extractParameters(invoiceRaw, {
      comparisonId,
      side: 'invoice',
      signal: controller.signal,
      batchConcurrency: options?.batchConcurrency,
      onItemDone: (item) => {
        persistOneItem(comparisonId, 'invoice_items', invoicePositionToId, item);
        bumpStageADone(comparisonId);
      },
      onItemFailed: (item, error) => {
        persistOneItem(comparisonId, 'invoice_items', invoicePositionToId, item);
        bumpStageADone(comparisonId);
        markStageAFailure(comparisonId, 'invoice', item.position, error.message);
      },
    });

    const [orderExtracted, invoiceExtracted] = config.EXTRACT_SIDES_PARALLEL
      ? await Promise.all([orderTask, invoiceTask])
      : [await orderTask, await invoiceTask];

    dumpJson(comparisonId, 'stage_a/order/_summary.json', orderExtracted);
    dumpJson(comparisonId, 'stage_a/invoice/_summary.json', invoiceExtracted);

    db.prepare(
      "UPDATE comparisons SET status = 'awaiting_method', progress = 50, stage_a_completed_at = datetime('now') WHERE id = ?"
    ).run(comparisonId);

    console.log(`[comparison] ${comparisonId} Stage A done — awaiting method selection`);
  } catch (err) {
    handlePipelineError(comparisonId, err);
  } finally {
    activeControllers.delete(comparisonId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE B — сравнение выбранным методом

/**
 * Запускается, когда пользователь выбрал метод. Загружает уже извлечённые
 * params_json из БД и запускает либо fuzzy, либо llm, либо оба.
 */
export async function runStageB(comparisonId: string, method: ComparisonMethod): Promise<void> {
  const db = getDb();
  const controller = new AbortController();
  activeControllers.set(comparisonId, controller);

  try {
    updateProgress(comparisonId, 'comparing', 55);

    // Зачищаем старые результаты на случай повторного запуска
    db.prepare('DELETE FROM comparison_results WHERE comparison_id = ?').run(comparisonId);

    const comparisonRow = db.prepare('SELECT user_prompt FROM comparisons WHERE id = ?').get(comparisonId) as
      | { user_prompt: string | null }
      | undefined;
    const userPrompt = comparisonRow?.user_prompt ?? null;

    const orderRows = db.prepare(
      'SELECT id, position, raw_name, params_json, quantity, unit, comment, comment_has_units FROM order_items WHERE comparison_id = ? ORDER BY position'
    ).all(comparisonId) as Array<{
      id: number;
      position: number;
      raw_name: string;
      params_json: string | null;
      quantity: number;
      unit: string;
      comment: string | null;
      comment_has_units: number;
    }>;
    const invoiceRows = db.prepare(
      'SELECT id, position, raw_name, params_json, quantity, unit FROM invoice_items WHERE comparison_id = ? ORDER BY position'
    ).all(comparisonId) as Array<{
      id: number;
      position: number;
      raw_name: string;
      params_json: string | null;
      quantity: number;
      unit: string;
    }>;

    const orderItems = orderRows.map((r) => parseParamsJson(r.params_json, r.position));
    const invoiceItems = invoiceRows.map((r) => parseParamsJson(r.params_json, r.position));

    const orderPosToId = new Map(orderRows.map((r) => [r.position, r.id]));
    const invoicePosToId = new Map(invoiceRows.map((r) => [r.position, r.id]));
    const orderQtyByPos = new Map(orderRows.map((r) => [r.position, { quantity: r.quantity, unit: r.unit }]));
    const invoiceQtyByPos = new Map(invoiceRows.map((r) => [r.position, { quantity: r.quantity, unit: r.unit }]));

    // Собираем значимые комментарии (для экономии токенов — только с единицами измерения).
    const orderComments = new Map<number, string>();
    for (const r of orderRows) {
      if (r.comment_has_units && r.comment) {
        orderComments.set(r.position, r.comment);
      }
    }

    let fuzzyMatches: MatchPair[] = [];
    let llmMatches: MatchPair[] = [];

    if (method === 'fuzzy' || method === 'both') {
      checkCancelled(comparisonId);
      fuzzyMatches = matchFuzzy(orderItems, invoiceItems, { comparisonId });
      updateProgress(comparisonId, 'comparing', method === 'both' ? 70 : 88);
    }

    if (method === 'llm' || method === 'both') {
      checkCancelled(comparisonId);
      llmMatches = await matchLlm(orderItems, invoiceItems, {
        comparisonId,
        signal: controller.signal,
        userPrompt,
        orderComments,
      });
      updateProgress(comparisonId, 'comparing', 88);
    }

    if (method === 'both') {
      const reconcile = buildReconcile(fuzzyMatches, llmMatches);
      dumpJson(comparisonId, 'stage_b/both/reconcile.json', reconcile);
      console.log(
        `[stage-b:both] ${comparisonId} reconcile: ${reconcile.agree} agree, ${reconcile.disagree} disagree`
      );
    }

    // ---------- Запись результатов в comparison_results ----------
    const insertResult = db.prepare(`
      INSERT INTO comparison_results (
        comparison_id, order_item_id, invoice_item_id,
        match_status, match_confidence,
        quantity_status, quantity_diff_pct, conversion_note,
        discrepancies_json, reasoning, method, split_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const writeBatch = (matches: MatchPair[], methodTag: string): void => {
      const usedInvoice = new Set<number>();
      for (const m of matches) {
        const orderItemId = orderPosToId.get(m.orderPosition) ?? null;
        if (m.invoicePosition != null) {
          // Определяем полный список позиций счёта (1:1 → [invoicePosition], 1→N → invoicePositions).
          const allInvoicePositions = Array.isArray(m.invoicePositions) && m.invoicePositions.length > 0
            ? m.invoicePositions
            : [m.invoicePosition];
          const primaryInvoiceItemId = invoicePosToId.get(m.invoicePosition) ?? null;

          // Помечаем все связанные строки счёта как использованные.
          for (const pos of allInvoicePositions) {
            const id = invoicePosToId.get(pos);
            if (id != null) usedInvoice.add(id);
          }

          // Сравнение количества (с агрегацией для 1→N).
          const orderQty = orderQtyByPos.get(m.orderPosition);
          let totalInvoiceQty = 0;
          let invoiceUnit = '';
          let hasQty = false;
          for (const pos of allInvoicePositions) {
            const inv = invoiceQtyByPos.get(pos);
            if (inv) {
              totalInvoiceQty += inv.quantity;
              if (!invoiceUnit) invoiceUnit = inv.unit;
              hasQty = true;
            }
          }

          let quantityStatus: string | null = null;
          let quantityDiffPct: number | null = null;
          let conversionNote: string | null = null;
          if (orderQty && hasQty) {
            const qc = compareQuantities(orderQty.quantity, orderQty.unit, totalInvoiceQty, invoiceUnit);
            quantityStatus = qc.status;
            quantityDiffPct = qc.diffPct;
            conversionNote = qc.note;
          }

          const status = m.decision?.derivedStatus ?? 'matched';
          const discrepancies = m.decision?.mismatches.length
            ? JSON.stringify(m.decision.mismatches.map((mm) => ({
                parameter: mm.parameter,
                order_value: mm.order_value,
                invoice_value: mm.invoice_value,
                severity: mm.severity,
              })))
            : null;

          // Запись о разбивке 1→N: сохраняем полный список позиций счёта и breakdown по подсистемам.
          let splitJson: string | null = null;
          if (allInvoicePositions.length > 1 || (m.splitByGroup && m.splitByGroup.length > 0)) {
            splitJson = JSON.stringify({
              invoicePositions: allInvoicePositions,
              totalInvoiceQty,
              invoiceUnit,
              byGroup: m.splitByGroup ?? null,
            });
          }

          insertResult.run(
            comparisonId, orderItemId, primaryInvoiceItemId,
            status, m.confidence,
            quantityStatus, quantityDiffPct, conversionNote,
            discrepancies, m.reasoning, methodTag, splitJson
          );
        } else {
          insertResult.run(
            comparisonId, orderItemId, null,
            'unmatched_order', null,
            null, null, null,
            null, m.reasoning, methodTag, null
          );
        }
      }
      // unmatched invoices
      for (const invRow of invoiceRows) {
        if (!usedInvoice.has(invRow.id)) {
          insertResult.run(
            comparisonId, null, invRow.id,
            'unmatched_invoice', null,
            null, null, null,
            null, 'Не найдено соответствие в заказе', methodTag, null
          );
        }
      }
    };

    db.transaction(() => {
      if (method === 'fuzzy') writeBatch(fuzzyMatches, 'single');
      else if (method === 'llm') writeBatch(llmMatches, 'single');
      else {
        writeBatch(fuzzyMatches, 'fuzzy');
        writeBatch(llmMatches, 'llm');
      }
    })();

    // ---------- Сводка ----------
    const summary = buildSummary(method, orderItems.length, invoiceItems.length, fuzzyMatches, llmMatches);

    db.prepare(
      'UPDATE comparisons SET summary_json = ?, status = ?, progress = ?, comparison_method = ? WHERE id = ?'
    ).run(JSON.stringify(summary), 'done', 100, method, comparisonId);

    console.log(`[comparison] ${comparisonId} Stage B (${method}) done`);
  } catch (err) {
    handlePipelineError(comparisonId, err);
  } finally {
    activeControllers.delete(comparisonId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backwards-compat: старое имя из routes.

export async function startComparison(comparisonId: string, options?: { batchConcurrency?: number }): Promise<void> {
  return runStageA(comparisonId, options);
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry одной позиции Stage A

export async function retryStageAItem(
  comparisonId: string,
  side: 'order' | 'invoice',
  position: number
): Promise<{ success: boolean; error?: string }> {
  const db = getDb();
  const table = side === 'order' ? 'order_items' : 'invoice_items';
  const row = db.prepare(
    `SELECT id, position, raw_name, quantity, unit FROM ${table} WHERE comparison_id = ? AND position = ?`
  ).get(comparisonId, position) as { id: number; position: number; raw_name: string; quantity: number; unit: string } | undefined;
  if (!row) return { success: false, error: 'Позиция не найдена' };

  const { item, ok, error } = await extractSingleParameter(
    { position: row.position, rawName: row.raw_name, unit: row.unit, quantity: row.quantity },
    { comparisonId, side, dumpName: `retry_${String(row.position).padStart(3, '0')}_${Date.now()}` }
  );

  persistOneItem(comparisonId, table, new Map([[row.position, row.id]]), item);

  if (ok) {
    db.prepare(
      'UPDATE comparisons SET stage_a_failed_position = NULL, stage_a_failed_side = NULL, stage_a_error = NULL WHERE id = ? AND stage_a_failed_position = ? AND stage_a_failed_side = ?'
    ).run(comparisonId, position, side);
    return { success: true };
  } else {
    return { success: false, error: error?.message ?? 'unknown error' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers

function pickGost(item: ExtractedItem): string | null {
  const std = item.standards ?? {};
  for (const k of ['gost', 'tu', 'sto']) {
    const v = std[k];
    if (v != null && v !== '') return String(v);
  }
  return null;
}

function persistOneItem(
  comparisonId: string,
  table: 'order_items' | 'invoice_items',
  positionToId: Map<number, number>,
  item: ExtractedItem
): void {
  const id = positionToId.get(item.position);
  if (id == null) return;
  const materialType = item.type ?? item.category ?? null;
  const gost = pickGost(item);
  getDb().prepare(
    `UPDATE ${table} SET material_type = ?, gost = ?, params_json = ? WHERE id = ?`
  ).run(materialType, gost, JSON.stringify(item), id);
}

function bumpStageADone(comparisonId: string): void {
  getDb().prepare(
    'UPDATE comparisons SET stage_a_done = stage_a_done + 1 WHERE id = ?'
  ).run(comparisonId);
}

function markStageAFailure(
  comparisonId: string,
  side: 'order' | 'invoice',
  position: number,
  errorMessage: string
): void {
  getDb().prepare(
    'UPDATE comparisons SET stage_a_failed_position = ?, stage_a_failed_side = ?, stage_a_error = ? WHERE id = ?'
  ).run(position, side, errorMessage.slice(0, 500), comparisonId);
}

function parseParamsJson(json: string | null, position: number): ExtractedItem {
  const fallback: ExtractedItem = {
    position,
    category: 'other',
    type: null,
    shape: null,
    geometry: {},
    material: {},
    standards: {},
    extra: {},
  };
  if (!json) return fallback;
  try {
    const parsed = JSON.parse(json) as ExtractedItem;
    return { ...parsed, position };
  } catch {
    return fallback;
  }
}

interface ReconcileEntry {
  orderPosition: number;
  fuzzyInvoicePosition: number | null;
  llmInvoicePosition: number | null;
  agree: boolean;
}

interface ReconcileSummary {
  agree: number;
  disagree: number;
  entries: ReconcileEntry[];
}

function buildReconcile(fuzzy: MatchPair[], llm: MatchPair[]): ReconcileSummary {
  const fuzzyMap = new Map(fuzzy.map((m) => [m.orderPosition, m.invoicePosition]));
  const llmMap = new Map(llm.map((m) => [m.orderPosition, m.invoicePosition]));
  const allOrders = new Set<number>([...fuzzyMap.keys(), ...llmMap.keys()]);
  let agree = 0;
  let disagree = 0;
  const entries: ReconcileEntry[] = [];
  for (const op of allOrders) {
    const f = fuzzyMap.get(op) ?? null;
    const l = llmMap.get(op) ?? null;
    const same = f === l;
    if (same) agree++;
    else disagree++;
    entries.push({ orderPosition: op, fuzzyInvoicePosition: f, llmInvoicePosition: l, agree: same });
  }
  return { agree, disagree, entries: entries.sort((a, b) => a.orderPosition - b.orderPosition) };
}

interface SummaryV2 {
  total_order: number;
  total_invoice: number;
  matched: number;
  unmatched_order: number;
  unmatched_invoice: number;
  critical_mismatches: number;
  warnings: number;
  method: ComparisonMethod;
}

function buildSummary(
  method: ComparisonMethod,
  totalOrder: number,
  totalInvoice: number,
  fuzzy: MatchPair[],
  llm: MatchPair[]
): SummaryV2 {
  // Для both — берём LLM как «основной» источник для сводки.
  const primary = method === 'fuzzy' ? fuzzy : llm.length > 0 ? llm : fuzzy;

  let matched = 0;
  let critical = 0;
  let warnings = 0;
  let unmatchedOrder = 0;
  for (const m of primary) {
    if (m.invoicePosition == null) {
      unmatchedOrder++;
      continue;
    }
    const status = m.decision?.derivedStatus ?? 'matched';
    if (status === 'matched') matched++;
    else if (status === 'partial') warnings++;
    else critical++;
  }

  const used = new Set(primary.filter((m) => m.invoicePosition != null).map((m) => m.invoicePosition!));
  const unmatchedInvoice = totalInvoice - used.size;

  return {
    total_order: totalOrder,
    total_invoice: totalInvoice,
    matched,
    unmatched_order: unmatchedOrder,
    unmatched_invoice: unmatchedInvoice,
    critical_mismatches: critical,
    warnings,
    method,
  };
}

function handlePipelineError(comparisonId: string, err: unknown): void {
  if (err instanceof CancellationError) {
    console.log(`[comparison] Cancelled: ${comparisonId}`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[comparison] Error for ${comparisonId}:`, message);
  getDb().prepare('UPDATE comparisons SET status = ?, error_message = ? WHERE id = ?')
    .run('error', message, comparisonId);
}
