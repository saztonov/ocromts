import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
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
  user_prompt: string | null;
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
  comment: string | null;
  comment_has_units: number;
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
  method?: string;
  split_json: string | null;
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
  const body = req.body as { name?: string; extractBatchConcurrency?: string | number; user_prompt?: string; userPrompt?: string };
  const name = body.name ?? null;
  // Только два валидных значения: 1 (безопасно) или 3 (быстро). Иначе берётся дефолт из config.
  const rawBC = Number(body.extractBatchConcurrency);
  const batchConcurrency = rawBC === 1 || rawBC === 3 ? rawBC : undefined;
  const userPromptRaw = (body.user_prompt ?? body.userPrompt ?? '').toString().trim();
  const userPrompt = userPromptRaw.length > 0 ? userPromptRaw : null;

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
    INSERT INTO comparisons (id, name, order_filename, invoice_filename, invoice_file_type, status, user_prompt)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(comparisonId, name, orderFile.filename, invoiceFile.filename, invoiceFileType, userPrompt);

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
    split_json: result.split_json ? JSON.parse(result.split_json) : null,
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

/**
 * GET /api/comparisons/:id/export
 * Выгрузка результатов сверки в Excel (две вкладки: Сводка и Результаты).
 */
router.get('/:id/export', (req: Request, res: Response): void => {
  const { id } = req.params;
  const db = getDb();

  const comparison = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(id) as
    | (ComparisonRow & { comparison_method?: string | null })
    | undefined;
  if (!comparison) {
    res.status(404).json({ error: 'Comparison not found' });
    return;
  }
  if (comparison.status !== 'done') {
    res.status(409).json({ error: `Экспорт доступен только для завершённых сверок (текущий статус: ${comparison.status})` });
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

  const orderById = new Map(orderItems.map((i) => [i.id, i]));
  const invoiceById = new Map(invoiceItems.map((i) => [i.id, i]));

  const summary = comparison.summary_json ? JSON.parse(comparison.summary_json) as {
    total_order?: number;
    total_invoice?: number;
    matched?: number;
    unmatched_order?: number;
    unmatched_invoice?: number;
    critical_mismatches?: number;
    warnings?: number;
  } : {};

  // ---- Sheet 1: Сводка ----
  const summaryRows: (string | number)[][] = [
    ['Сверка', comparison.name ?? ''],
    ['ID', comparison.id],
    ['Файл заказа', comparison.order_filename],
    ['Файл счёта', comparison.invoice_filename],
    ['Метод сравнения', comparison.comparison_method ?? ''],
    ['Дата создания', comparison.created_at],
    [],
    ['Всего в заказе', summary.total_order ?? 0],
    ['Всего в счёте', summary.total_invoice ?? 0],
    ['Совпало', summary.matched ?? 0],
    ['Частичные (warnings)', summary.warnings ?? 0],
    ['Критические расхождения', summary.critical_mismatches ?? 0],
    ['Нет в счёте', summary.unmatched_order ?? 0],
    ['Лишние в счёте', summary.unmatched_invoice ?? 0],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 28 }, { wch: 60 }];

  // ---- Sheet 2: Результаты ----
  const statusLabel: Record<string, string> = {
    matched: 'Совпало',
    partial: 'Частично',
    mismatch: 'Расхождение',
    unmatched_order: 'Нет в счёте',
    unmatched_invoice: 'Лишнее в счёте',
  };
  const qtyStatusLabel: Record<string, string> = {
    exact: 'Точно',
    within_tolerance: 'В допуске',
    over: 'Больше',
    under: 'Меньше',
    incompatible_units: 'Несовместимые ед.',
  };

  interface DiscrepancyItem {
    parameter?: string;
    spec_value?: string | null;
    invoice_value?: string | null;
    severity?: string;
    comment?: string;
  }

  const sorted = [...results].sort((a, b) => {
    const oa = a.order_item_id ? orderById.get(a.order_item_id)?.position ?? Infinity : Infinity;
    const ob = b.order_item_id ? orderById.get(b.order_item_id)?.position ?? Infinity : Infinity;
    if (oa !== ob) return oa - ob;
    const ia = a.invoice_item_id ? invoiceById.get(a.invoice_item_id)?.position ?? Infinity : Infinity;
    const ib = b.invoice_item_id ? invoiceById.get(b.invoice_item_id)?.position ?? Infinity : Infinity;
    return ia - ib;
  });

  const header = [
    '#',
    'Поз. заказа', 'Наименование (заказ)', 'Кол-во заказ', 'Ед. заказ', 'Комментарий заказа',
    'Поз. счёта', 'Наименование (счёт)', 'Кол-во счёт', 'Ед. счёт', 'Цена', 'Сумма',
    'Статус', 'Кол-во статус', 'Δ %', 'Confidence %', 'Метод',
    'Разбивка по подсистемам',
    'Расхождения', 'Комментарий модели', 'Конвертация ед.',
  ];

  interface SplitJsonShape {
    invoicePositions?: number[];
    totalInvoiceQty?: number;
    invoiceUnit?: string;
    byGroup?: Array<{ group: string | null; invoicePosition: number; qty: number | null }> | null;
  }

  const dataRows: (string | number | null)[][] = sorted.map((r, idx) => {
    const o = r.order_item_id ? orderById.get(r.order_item_id) : undefined;
    const inv = r.invoice_item_id ? invoiceById.get(r.invoice_item_id) : undefined;

    let discrepancies: DiscrepancyItem[] = [];
    if (r.discrepancies_json) {
      try {
        const parsed = JSON.parse(r.discrepancies_json);
        if (Array.isArray(parsed)) discrepancies = parsed as DiscrepancyItem[];
      } catch {
        // ignore malformed
      }
    }
    const discrText = discrepancies
      .map((d) => {
        const sev = d.severity ? `[${d.severity}] ` : '';
        const param = d.parameter ?? '';
        const spec = d.spec_value ?? '—';
        const invVal = d.invoice_value ?? '—';
        const cmt = d.comment ? ` (${d.comment})` : '';
        return `${sev}${param}: ${spec} → ${invVal}${cmt}`;
      })
      .join('\n');

    let splitText = '';
    if (r.split_json) {
      try {
        const sp = JSON.parse(r.split_json) as SplitJsonShape;
        if (sp.byGroup && sp.byGroup.length > 0) {
          splitText = sp.byGroup
            .map((g) => `${g.group ?? '—'}: ${g.qty ?? '—'} ${sp.invoiceUnit ?? ''} (поз. ${g.invoicePosition})`)
            .join('\n');
        } else if (sp.invoicePositions && sp.invoicePositions.length > 1) {
          splitText = `строки счёта: ${sp.invoicePositions.join(', ')}; всего ${sp.totalInvoiceQty ?? '—'} ${sp.invoiceUnit ?? ''}`;
        }
      } catch {
        // ignore
      }
    }

    return [
      idx + 1,
      o?.position ?? null, o?.raw_name ?? '', o?.quantity ?? null, o?.unit ?? '', o?.comment ?? '',
      inv?.position ?? null, inv?.raw_name ?? '', inv?.quantity ?? null, inv?.unit ?? '',
      inv?.unit_price ?? null, inv?.total_price ?? null,
      statusLabel[r.match_status] ?? r.match_status,
      r.quantity_status ? (qtyStatusLabel[r.quantity_status] ?? r.quantity_status) : '',
      r.quantity_diff_pct ?? null,
      r.match_confidence != null ? Math.round(r.match_confidence * 100) : null,
      (r as ComparisonResultRow & { method?: string }).method ?? '',
      splitText,
      discrText,
      r.reasoning ?? '',
      r.conversion_note ?? '',
    ];
  });

  const wsResults = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
  wsResults['!cols'] = [
    { wch: 5 },
    { wch: 8 }, { wch: 50 }, { wch: 11 }, { wch: 8 }, { wch: 30 },
    { wch: 8 }, { wch: 50 }, { wch: 11 }, { wch: 8 }, { wch: 11 }, { wch: 12 },
    { wch: 16 }, { wch: 16 }, { wch: 8 }, { wch: 13 }, { wch: 8 },
    { wch: 40 },
    { wch: 60 }, { wch: 60 }, { wch: 30 },
  ];
  // Включить перенос строк для текстовых колонок: комментарий заказа (5), разбивка (17), расхождения (18), reasoning (19), конвертация (20)
  const range = XLSX.utils.decode_range(wsResults['!ref'] ?? 'A1');
  for (let R = 1; R <= range.e.r; R++) {
    for (const C of [5, 17, 18, 19, 20]) {
      const cell = wsResults[XLSX.utils.encode_cell({ r: R, c: C })];
      if (cell) cell.s = { alignment: { wrapText: true, vertical: 'top' } };
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Сводка');
  XLSX.utils.book_append_sheet(wb, wsResults, 'Результаты');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const baseName = (comparison.name ?? `comparison-${comparison.id}`).replace(/[\\/:*?"<>|]/g, '_');
  const fallback = `comparison-${comparison.id}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(baseName + '.xlsx')}`
  );
  res.send(buf);
});

export default router;
