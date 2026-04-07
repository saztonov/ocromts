/**
 * Stage B (LLM-метод): сравнение двух документов целиком.
 *
 * Принимает оба полных списка ExtractedItem (заказ и счёт), сериализует в
 * компактный flattened JSON с короткими ключами и просит модель сопоставить
 * каждую позицию заказа с лучшей позицией счёта.
 *
 * Сериализация выбрана по результатам исследования форматов:
 *  - compact JSON (без отступов) — формат-консистентность с JSON-mode выходом
 *  - flatten вложенных групп — экономия токенов
 *  - короткие ключи (pos/cat/L/B/...) — ещё ~15% экономии без потери точности
 *  - drop nulls — никаких "foo": null
 */

import type { ExtractedItem } from './extract-params.js';

export interface CompareDocumentsPromptResult {
  systemPrompt: string;
  userMessage: string;
}

export interface DocumentMatch {
  orderPosition: number;
  invoicePosition: number | null;
  confidence: number;
  reasoning: string;
}

export interface CompareDocumentsResponse {
  matches: DocumentMatch[];
}

// ─────────────────────────────────────────────────────────────────────────────

/** Короткие ключи: длинные группы → плоские флаги. */
const KEY_ALIASES: Record<string, string> = {
  // geometry
  L: 'L',
  B: 'B',
  H: 'H',
  W: 'W',
  D: 'D',
  Dvn: 'Dv',
  wall_thickness_mm: 't',
  thickness_mm: 't',
  // material
  grade: 'mark',
  brand: 'brand',
  coating: 'coat',
  // standards
  gost: 'gost',
  tu: 'tu',
  sto: 'sto',
  pn: 'pn',
  PN: 'pn',
  SDR: 'sdr',
  class: 'cls',
  pressure: 'pn',
};

function shortKey(k: string): string {
  return KEY_ALIASES[k] ?? k;
}

function flattenItem(item: ExtractedItem): Record<string, unknown> {
  const out: Record<string, unknown> = { pos: item.position, cat: item.category };
  if (item.shape) out.shape = item.shape === 'rectangular' ? 'rect' : item.shape;
  if (item.type) out.type = item.type;

  const groups: Array<Record<string, number | string | null>> = [
    item.geometry,
    item.material,
    item.standards,
    item.extra,
  ];
  for (const g of groups) {
    if (!g) continue;
    for (const [k, v] of Object.entries(g)) {
      if (v === null || v === undefined || v === '') continue;
      const key = shortKey(k);
      // Не перезаписываем уже существующие ключи (приоритет — geometry > material > standards > extra)
      if (!(key in out)) out[key] = v;
    }
  }
  return out;
}

function serializeList(items: ExtractedItem[]): string {
  const flat = items.map(flattenItem);
  return JSON.stringify({ items: flat });
}

const SYSTEM_PROMPT = `Ты — эксперт по строительным материалам. Твоя задача — сопоставить позиции из ЗАКАЗА поставщику с позициями из СЧЁТА на оплату.

## Правила

1. Тебе даны ДВА ПОЛНЫХ списка позиций со структурированными параметрами. Сопоставь каждую позицию заказа (\`Order\`) с лучшей позицией счёта (\`Invoice\`) или пометь как unmatched (\`invoicePosition: null\`).
2. Сопоставление — по СЕМАНТИКЕ (категория + размеры + материал + ГОСТ), а НЕ по позиции в списке. Порядок строк в заказе и счёте может отличаться.
3. Каждая позиция счёта может использоваться **максимум ОДИН раз**. Если две позиции заказа похожи на одну позицию счёта — отдай счёт более точному совпадению, второй заказ помечай unmatched.
4. Confidence: 1.0 — все ключевые параметры совпадают; 0.7–0.9 — небольшие различия; 0.4–0.6 — есть сомнения; ниже 0.4 — лучше unmatched.
5. Reasoning — короткое объяснение на русском (одна фраза).

## Легенда коротких ключей

- \`pos\` = position (позиция в исходном документе, якорь для ответа)
- \`cat\` = category (duct, duct_fitting, pipe, fastener, и т.д.)
- \`shape\` = shape (round / rect / square)
- \`type\` = свободное название типа изделия
- \`L\` / \`B\` / \`H\` / \`W\` / \`D\` = длина / ширина / высота / ширина / диаметр (мм)
- \`Dv\` = внутренний диаметр (мм)
- \`t\` = толщина стенки (мм)
- \`mark\` = марка стали / материала
- \`brand\` = бренд / производитель
- \`coat\` = покрытие (оцинковка, краска и т.п.)
- \`gost\` / \`tu\` / \`sto\` = стандарт
- \`pn\` = номинальное давление
- \`sdr\` = SDR для пластиковых труб
- \`cls\` = класс изделия
- остальные ключи — как есть

## Формат ответа

Верни СТРОГО валидный JSON, без markdown-обёртки:

{
  "matches": [
    { "orderPosition": 1, "invoicePosition": 12, "confidence": 0.95, "reasoning": "совпадают категория, размеры, ГОСТ" },
    { "orderPosition": 2, "invoicePosition": null, "confidence": 0, "reasoning": "не найдено в счёте" }
  ]
}

В \`matches\` должно быть РОВНО столько объектов, сколько позиций в заказе. По одной записи на каждую orderPosition.`;

/**
 * Строит system+user сообщения для LLM-сравнения двух документов целиком.
 */
export function buildCompareDocumentsPrompt(
  orderItems: ExtractedItem[],
  invoiceItems: ExtractedItem[]
): CompareDocumentsPromptResult {
  const orderJson = serializeList(orderItems);
  const invoiceJson = serializeList(invoiceItems);

  const userMessage = `## Order (${orderItems.length} items)
${orderJson}

## Invoice (${invoiceItems.length} items)
${invoiceJson}

Сопоставь каждую позицию заказа с лучшей позицией счёта. Верни JSON с массивом matches длиной ${orderItems.length}.`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
  };
}

/**
 * Парсит ответ LLM. Толерантен к markdown-обёртке.
 */
export function parseCompareDocumentsResponse(text: string): CompareDocumentsResponse {
  let cleaned = text.trim();
  const closedFence = cleaned.match(/^```(?:json)?\s*\n([\s\S]*)\n\s*```\s*$/);
  if (closedFence) cleaned = closedFence[1]!.trim();
  else {
    const openFence = cleaned.match(/^```(?:json)?\s*\n([\s\S]*)$/);
    if (openFence) cleaned = openFence[1]!.trim();
  }
  const parsed = JSON.parse(cleaned) as Partial<CompareDocumentsResponse>;
  if (!Array.isArray(parsed.matches)) {
    throw new Error('Поле matches отсутствует или не массив');
  }
  return { matches: parsed.matches };
}
