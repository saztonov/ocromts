import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (two levels up from server/src/)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface AppConfig {
  PORT: number;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL_VISION: string;
  OPENROUTER_MODEL_COMPARE: string;
  UPLOADS_DIR: string;
  DB_PATH: string;
  LLM_CALL_TIMEOUT_MS: number;
}

export const config: AppConfig = {
  PORT: parseInt(process.env.PORT ?? '3001', 10),
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '',
  OPENROUTER_MODEL_VISION: process.env.OPENROUTER_MODEL_VISION ?? 'google/gemini-2.5-flash',
  OPENROUTER_MODEL_COMPARE: process.env.OPENROUTER_MODEL_COMPARE ?? 'anthropic/claude-sonnet-4',
  UPLOADS_DIR: path.resolve(__dirname, '../../uploads'),
  DB_PATH: path.resolve(__dirname, '../../data.db'),
  LLM_CALL_TIMEOUT_MS: Number(process.env.LLM_CALL_TIMEOUT_MS ?? 600_000),
};
