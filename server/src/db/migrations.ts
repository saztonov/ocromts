import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function runMigrations(): void {
  const schemaPath = path.resolve(__dirname, 'schema.sql');

  // When running from compiled dist/, fall back to the source schema
  const resolvedPath = fs.existsSync(schemaPath)
    ? schemaPath
    : path.resolve(__dirname, '../../src/db/schema.sql');

  const schema = fs.readFileSync(resolvedPath, 'utf-8');
  const db = getDb();

  db.exec(schema);

  // Add new columns for existing databases (idempotent)
  const columns = db.prepare("PRAGMA table_info(comparisons)").all() as { name: string }[];
  const colNames = new Set(columns.map((c) => c.name));
  if (!colNames.has('progress')) {
    db.exec("ALTER TABLE comparisons ADD COLUMN progress INTEGER NOT NULL DEFAULT 0");
  }
  if (!colNames.has('cancelled_at')) {
    db.exec("ALTER TABLE comparisons ADD COLUMN cancelled_at TEXT");
  }
  if (!colNames.has('comparison_method')) {
    db.exec("ALTER TABLE comparisons ADD COLUMN comparison_method TEXT");
  }
  if (!colNames.has('stage_a_total')) {
    db.exec("ALTER TABLE comparisons ADD COLUMN stage_a_total INTEGER NOT NULL DEFAULT 0");
  }
  if (!colNames.has('stage_a_done')) {
    db.exec("ALTER TABLE comparisons ADD COLUMN stage_a_done INTEGER NOT NULL DEFAULT 0");
  }
  if (!colNames.has('stage_a_failed_position')) {
    db.exec("ALTER TABLE comparisons ADD COLUMN stage_a_failed_position INTEGER");
  }
  if (!colNames.has('stage_a_failed_side')) {
    db.exec("ALTER TABLE comparisons ADD COLUMN stage_a_failed_side TEXT");
  }
  if (!colNames.has('stage_a_error')) {
    db.exec("ALTER TABLE comparisons ADD COLUMN stage_a_error TEXT");
  }
  if (!colNames.has('stage_a_completed_at')) {
    db.exec("ALTER TABLE comparisons ADD COLUMN stage_a_completed_at TEXT");
  }
  if (!colNames.has('user_prompt')) {
    db.exec("ALTER TABLE comparisons ADD COLUMN user_prompt TEXT");
  }

  const orderItemColumns = db.prepare("PRAGMA table_info(order_items)").all() as { name: string }[];
  const orderItemColNames = new Set(orderItemColumns.map((c) => c.name));
  if (!orderItemColNames.has('comment')) {
    db.exec("ALTER TABLE order_items ADD COLUMN comment TEXT");
  }
  if (!orderItemColNames.has('comment_has_units')) {
    db.exec("ALTER TABLE order_items ADD COLUMN comment_has_units INTEGER NOT NULL DEFAULT 0");
  }

  const resultColumns = db.prepare("PRAGMA table_info(comparison_results)").all() as { name: string }[];
  const resultColNames = new Set(resultColumns.map((c) => c.name));
  if (!resultColNames.has('method')) {
    db.exec("ALTER TABLE comparison_results ADD COLUMN method TEXT NOT NULL DEFAULT 'single'");
  }
  if (!resultColNames.has('split_json')) {
    db.exec("ALTER TABLE comparison_results ADD COLUMN split_json TEXT");
  }

  // Clean up comparisons stuck in processing state (e.g. server crashed mid-comparison)
  const stuck = db.prepare(
    "UPDATE comparisons SET status = 'error', error_message = 'Обработка прервана перезапуском сервера' WHERE status IN ('parsing', 'comparing', 'extracting', 'awaiting_method')"
  ).run();
  if (stuck.changes > 0) {
    console.log(`[migrations] Reset ${stuck.changes} stuck comparison(s) to error`);
  }

  console.log('[migrations] Schema applied successfully');
}
