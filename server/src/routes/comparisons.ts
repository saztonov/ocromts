import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { config } from '../config.js';
import { startComparison, cancelComparison, runStageB, retryStageAItem, type ComparisonMethod } from '../services/comparison.js';

// ---- DB row types ---- //

interface ComparisonRow {
  id: string;
  name: string | null;
  order_filename: string;
  invoice_filename: string;
  invoice_file_type: string;
  status: string;
  error_message: string | null;
  created_at: string;
  summary_json: string | null;
}

interface OrderItemRow {
  id: number;
  comparison_id: string;
  position: number;
  raw_name: string;
  material_type: string | null;
  gost: string | null;
  params_json: string | null;
  quantity: number;
  unit: string;
}

interface InvoiceItemRow {
  id: number;
  comparison_id: string;
  position: number;
  raw_name: string;
  material_type: string | null;
  gost: string | null;
  params_json: string | null;
  quantity: number;
  unit: string;
  unit_price: number | null;
  total_price: number | null;
}

interface ComparisonResultRow {
  id: number;
  comparison_id: string;
  order_item_id: number | null;
  invoice_item_id: number | null;
  match_status: string;
  match_confidence: number | null;
  quantity_status: string | null;
  quantity_diff_pct: number | null;
  conversion_note: string | null;
  discrepancies_json: string | null;
  reasoning: string | null;
}

// ---- Multer file type ---- //

interface MulterFiles {
  orderFile?: Express.Multer.File[];
  invoiceFile?: Express.Multer.File[];
}

// ---- Router ---- //

const router = Router();

/**
 * POST /api/comparisons
 * Upload order + invoice files and start async comparison.
 */
router.post('/', (req: Request, res: Response): void => {
  const files = req.files as MulterFiles | undefined;

  if (!files?.orderFile?.[0] || !files?.invoiceFile?.[0]) {
    res.status(400).json({
      error: 'Both orderFile and invoiceFile are required',
    });
    return;
  }

  const orderFile = files.orderFile[0];
  const invoiceFile = files.invoiceFile[0];
  const body = req.body as { name?: string; extractBatchConcurrency?: string | number };
  const name = body.name ?? null;
  // Только два валидных значения: 1 (безопасно) или 3 (быстро). Иначе берётся дефолт из config.
  const rawBC = Number(body.extractBatchConcurrency);
  const batchConcurrency = rawBC === 1 || rawBC === 3 ? rawBC : undefined;

  // Determine invoice file type
  const invoiceExt = path.extname(invoiceFile.originalname).toLowerCase();
  let invoiceFileType: string;
  if (invoiceExt === '.pdf') {
    invoiceFileType = 'pdf';
  } else if (['.xlsx', '.xls'].includes(invoiceExt)) {
    invoiceFileType = 'excel';
  } else {
    res.status(400).json({
      error: `Unsupported invoice file type: ${invoiceExt}. Use PDF or Excel.`,
    });
    return;
  }

  // The comparison ID was set by multer's storage (extracted from the destination path)
  const comparisonId = path.basename(path.dirname(orderFile.path));

  const db = getDb();
  db.prepare(`
    INSERT INTO comparisons (id, name, order_filename, invoice_filename, invoice_file_type, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(comparisonId, name, orderFile.filename, invoiceFile.filename, invoiceFileType);

  // Start async processing (fire and forget)
  startComparison(comparisonId, { batchConcurrency }).catch((err) => {
    console.error(`[routes] Unhandled error in comparison ${comparisonId}:`, err);
  });

  res.status(201).json({
    id: comparisonId,
    status: 'pending',
  });
});

/**
 * GET /api/comparisons
 * List all comparisons ordered by created_at DESC.
 */
router.get('/', (_req: Request, res: Response): void => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, order_filename, invoice_filename, invoice_file_type,
           status, error_message, created_at, summary_json
    FROM comparisons
    ORDER BY created_at DESC
  `).all() as ComparisonRow[];

  const comparisons = rows.map((row) => ({
    ...row,
    summary_json: row.summary_json ? JSON.parse(row.summary_json) : null,
  }));

  res.json(comparisons);
});

/**
 * GET /api/comparisons/:id
 * Get a single comparison with all related items and results.
 */
router.get('/:id', (req: Request, res: Response): void => {
  const { id } = req.params;
  const db = getDb();

  const comparison = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(id) as ComparisonRow | undefined;
  if (!comparison) {
    res.status(404).json({ error: 'Comparison not found' });
    return;
  }

  const orderItems = db.prepare(
    'SELECT * FROM order_items WHERE comparison_id = ? ORDER BY position'
  ).all(id) as OrderItemRow[];

  const invoiceItems = db.prepare(
    'SELECT * FROM invoice_items WHERE comparison_id = ? ORDER BY position'
  ).all(id) as InvoiceItemRow[];

  const results = db.prepare(
    'SELECT * FROM comparison_results WHERE comparison_id = ? ORDER BY id'
  ).all(id) as ComparisonResultRow[];

  // Parse JSON fields
  const parsedOrderItems = orderItems.map((item) => ({
    ...item,
    params_json: item.params_json ? JSON.parse(item.params_json) : null,
  }));

  const parsedInvoiceItems = invoiceItems.map((item) => ({
    ...item,
    params_json: item.params_json ? JSON.parse(item.params_json) : null,
  }));

  const parsedResults = results.map((result) => ({
    ...result,
    discrepancies_json: result.discrepancies_json
      ? JSON.parse(result.discrepancies_json)
      : null,
  }));

  res.json({
    ...comparison,
    summary_json: comparison.summary_json ? JSON.parse(comparison.summary_json) : null,
    order_items: parsedOrderItems,
    invoice_items: parsedInvoiceItems,
    comparison_results: parsedResults,
  });
});

/**
 * POST /api/comparisons/:id/compare
 * После Stage A пользователь выбирает метод сравнения.
 * Body: { method: 'fuzzy' | 'llm' | 'both' }
 */
router.post('/:id/compare', (req: Request, res: Response): void => {
  const id = req.params.id as string;
  const body = req.body as { method?: string };
  const method = body.method;

  if (!method || !['fuzzy', 'llm', 'both'].includes(method)) {
    res.status(400).json({ error: 'method должен быть fuzzy | llm | both' });
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT status FROM comparisons WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Comparison not found' });
    return;
  }
  if (row.status !== 'awaiting_method') {
    res.status(409).json({ error: `Невозможно запустить сравнение из статуса "${row.status}". Ожидается "awaiting_method".` });
    return;
  }

  // fire-and-forget
  runStageB(id, method as ComparisonMethod).catch((err) => {
    console.error(`[routes] Unhandled error in runStageB ${id}:`, err);
  });

  res.status(202).json({ id, status: 'comparing', method });
});

/**
 * POST /api/comparisons/:id/retry-item
 * Повторная обработка одной позиции Stage A (при сбое отдельной строки).
 * Body: { side: 'order' | 'invoice', position: number }
 */
router.post('/:id/retry-item', (req: Request, res: Response): void => {
  const id = req.params.id as string;
  const body = req.body as { side?: string; position?: number };
  if (!body.side || !['order', 'invoice'].includes(body.side) || typeof body.position !== 'number') {
    res.status(400).json({ error: 'side и position обязательны' });
    return;
  }

  retryStageAItem(id, body.side as 'order' | 'invoice', body.position)
    .then((result) => {
      if (result.success) res.json({ success: true });
      else res.status(500).json({ error: result.error ?? 'unknown' });
    })
    .catch((err) => {
      console.error(`[routes] retry-item ${id}:`, err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    });
});

/**
 * POST /api/comparisons/:id/cancel
 * Cancel an in-progress comparison.
 */
router.post('/:id/cancel', (req: Request, res: Response): void => {
  const id = req.params.id as string;
  const cancelled = cancelComparison(id);
  if (cancelled) {
    res.json({ success: true });
  } else {
    res.status(409).json({ error: 'Сверку невозможно отменить (уже завершена или не найдена)' });
  }
});

/**
 * DELETE /api/comparisons/:id
 * Delete a comparison and its uploaded files.
 */
router.delete('/:id', (req: Request, res: Response): void => {
  const id = req.params.id as string;
  const db = getDb();

  const comparison = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(id) as ComparisonRow | undefined;
  if (!comparison) {
    res.status(404).json({ error: 'Comparison not found' });
    return;
  }

  // Delete from DB (cascade will remove items and results)
  db.prepare('DELETE FROM comparisons WHERE id = ?').run(id);

  // Delete uploaded files
  const uploadsDir = path.join(config.UPLOADS_DIR, id);
  if (fs.existsSync(uploadsDir)) {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }

  res.json({ success: true });
});

export default router;
