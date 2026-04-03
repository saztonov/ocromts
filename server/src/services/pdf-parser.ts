import fs from 'node:fs';
import { callOpenRouter } from './llm.js';
import { normalizeUnit } from './unit-converter.js';
import { config } from '../config.js';
import {
  PDF_EXTRACTION_SYSTEM_PROMPT,
  buildPdfExtractionUserContent,
} from '../prompts/extract-pdf.js';

export interface ParsedItem {
  position: number;
  rawName: string;
  unit: string;
  quantity: number;
  unitPrice?: number;
  totalPrice?: number;
}

interface PdfExtractionItem {
  row_number: number;
  raw_name: string;
  unit: string;
  quantity: number;
  unit_price?: number | null;
  total_price?: number | null;
}

interface PdfExtractionResult {
  document_type?: string;
  supplier_name?: string | null;
  document_number?: string | null;
  document_date?: string | null;
  items: PdfExtractionItem[];
  totals?: {
    subtotal?: number | null;
    vat?: number | null;
    total?: number | null;
  };
}

/**
 * Parses a PDF invoice by sending it as base64 to a vision-capable LLM
 * and extracting structured material data from the response.
 */
export async function parsePdf(filePath: string, signal?: AbortSignal): Promise<ParsedItem[]> {
  const fileBuffer = fs.readFileSync(filePath);
  const base64Pdf = fileBuffer.toString('base64');

  console.log(`[pdf-parser] Sending PDF (${Math.round(fileBuffer.length / 1024)}KB) to vision model`);

  const userContent = buildPdfExtractionUserContent(base64Pdf);

  const responseText = await callOpenRouter({
    model: config.OPENROUTER_MODEL_VISION,
    messages: [
      { role: 'system', content: PDF_EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.05,
    responseFormat: { type: 'json_object' },
    signal,
  });

  const parsed = parseJsonResponse(responseText);

  if (!parsed.items || !Array.isArray(parsed.items)) {
    throw new Error('PDF extraction did not return an items array');
  }

  console.log(
    `[pdf-parser] Extracted ${parsed.items.length} items` +
    (parsed.document_type ? ` from ${parsed.document_type}` : '') +
    (parsed.supplier_name ? ` (supplier: ${parsed.supplier_name})` : '')
  );

  return parsed.items.map((item, index) => ({
    position: item.row_number ?? index + 1,
    rawName: item.raw_name,
    unit: normalizeUnit(item.unit ?? ''),
    quantity: typeof item.quantity === 'number' ? item.quantity : parseFloat(String(item.quantity)) || 0,
    unitPrice: item.unit_price != null ? item.unit_price : undefined,
    totalPrice: item.total_price != null ? item.total_price : undefined,
  }));
}

/**
 * Attempts to parse a JSON response that may be wrapped in markdown code fences.
 */
function parseJsonResponse(text: string): PdfExtractionResult {
  const cleaned = stripMarkdownFences(text);

  try {
    return JSON.parse(cleaned) as PdfExtractionResult;
  } catch {
    throw new Error(`Failed to parse PDF extraction response as JSON: ${cleaned.slice(0, 200)}`);
  }
}

/**
 * Strips markdown code fences from LLM response.
 * Handles both closed (```json ... ```) and unclosed (```json ... EOF) fences.
 */
function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();

  const closedFence = cleaned.match(/^```(?:json)?\s*\n([\s\S]*)\n\s*```\s*$/);
  if (closedFence) {
    return closedFence[1]!.trim();
  }

  const openFence = cleaned.match(/^```(?:json)?\s*\n([\s\S]*)$/);
  if (openFence) {
    return openFence[1]!.trim();
  }

  return cleaned;
}
