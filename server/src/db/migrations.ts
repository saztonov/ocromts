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

  // Clean up comparisons stuck in processing state (e.g. server crashed mid-comparison)
  const stuck = db.prepare(
    "UPDATE comparisons SET status = 'error', error_message = 'Обработка прервана перезапуском сервера' WHERE status IN ('parsing', 'comparing')"
  ).run();
  if (stuck.changes > 0) {
    console.log(`[migrations] Reset ${stuck.changes} stuck comparison(s) to error`);
  }

  console.log('[migrations] Schema applied successfully');
}
