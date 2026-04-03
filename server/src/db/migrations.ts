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
  console.log('[migrations] Schema applied successfully');
}
