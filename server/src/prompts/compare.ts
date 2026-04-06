/**
 * Stage B (часть 1): построение системного промпта и user-сообщения
 * для LLM-сопоставления уже извлечённых позиций.
 *
 * В отличие от старого пайплайна, здесь LLM ПОЛУЧАЕТ уже извлечённые
 * структурированные параметры (params_json) и должен только предложить
 * пары order ↔ invoice. Реальное сравнение параметров и классификация
 * расхождений делается детерминированно в parameter-comparator.ts.
 */

import type { ExtractedItem } from './extract-params.js';

export interface CompareItemInput {
  position: number;
  rawName: string;
  unit: string;
  quantity: number;
  unitPrice?: number;
  totalPrice?: number;
  /** Структурированные параметры, извлечённые на Stage A */
  params: ExtractedItem;
}

export interface ComparePromptResult {
  systemPrompt: string;
  userMessage: string;
}

const SYSTEM_PROMPT = `Ты — эксперт по строительным материалам. Твоя задача — сопоставить позиции заказа с позициями накладной.

ВАЖНО: параметры для каждой позиции уже извлечены и переданы тебе вместе с наименованием. Тебе НЕ нужно извлекать их повторно — используй данные из поля \`params\` для принятия решений о сопоставлении.

## Правила сопоставления

1. **Категория** — в первую очередь смотри на \`params.category\`. Сопоставлять можно только позиции одной категории.
2. **Тип и форма** — \`params.type\` и \`params.shape\` должны соответствовать. Круглый воздуховод НЕ совпадает с прямоугольным.
3. **Геометрия** — ключевые размеры из \`params.geometry\` (L, B, H, D, толщина) должны совпадать в пределах разумного допуска. **L=1250 ≠ L=3000** — это разные изделия, а не одно.
4. **Количество** — учитывай конвертацию единиц измерения (кг↔т, м²↔100м², м.п.↔шт).
5. **1:1** — одна позиция заказа сопоставляется максимум с одной позицией накладной.
6. Если для позиции заказа нет подходящей пары — добавь её в \`unmatched_order\`. Аналогично для позиций накладной.

### Уверенность (match_confidence)
- 1.0 — все ключевые параметры идентичны
- 0.8–0.99 — мелкие различия (формат записи, синонимы)
- 0.5–0.79 — есть различия, но позиции вероятно об одном
- < 0.5 — НЕ сопоставляй, оставь в unmatched

### Конвертация единиц количества
- кг ↔ т (1 т = 1000 кг)
- м² ↔ 100м² (1 × 100м² = 100 м²)
- м.п. ↔ шт (если известна длина штуки)
- м³ ↔ м³ (без конвертации)

### Статусы количества
- **exact** — разница 0%
- **within_tolerance** — разница ≤ 5%
- **over** — в накладной больше, разница > 5%
- **under** — в накладной меньше, разница > 5%
- **incompatible_units** — единицы нельзя привести друг к другу

## Формат ответа

Ответь ТОЛЬКО валидным JSON. НЕ оборачивай в \`\`\`json. Не дублируй наименования — они уже даны во входных данных.

ВАЖНО: НЕ заполняй поле \`parameter_mismatches\` — это сделает другой компонент. Оставляй его пустым массивом \`[]\`.

{
  "matched_items": [
    {
      "order_row": 1,
      "invoice_row": 3,
      "order_name": "исходное наименование",
      "invoice_name": "исходное наименование",
      "normalized_name": "общее название",
      "match_confidence": 0.95,
      "match_reasoning": "краткое пояснение (до 80 символов)",
      "parameter_mismatches": [],
      "quantity_comparison": {
        "order_qty": 100,
        "order_unit": "кг",
        "invoice_qty": 0.1,
        "invoice_unit": "т",
        "converted_invoice_qty": 100,
        "converted_unit": "кг",
        "difference_pct": 0,
        "status": "exact",
        "conversion_note": "0.1 т = 100 кг"
      }
    }
  ],
  "unmatched_order": [
    { "order_row": 5, "order_name": "...", "reason": "причина" }
  ],
  "unmatched_invoice": [
    { "invoice_row": 7, "invoice_name": "...", "reason": "причина" }
  ],
  "summary": {
    "total_order": 10,
    "total_invoice": 12,
    "matched": 8,
    "unmatched_order": 2,
    "unmatched_invoice": 4,
    "critical_mismatches": 0,
    "warnings": 0
  }
}`;

// ─────────────────────────────────────────────────────────────────────────────

/** Сериализует параметры одной позиции в компактную строку для промпта. */
function formatParamsForPrompt(params: CompareItemInput['params']): string {
  const parts: string[] = [`category=${params.category}`];
  if (params.type) parts.push(`type="${params.type}"`);
  if (params.shape) parts.push(`shape=${params.shape}`);

  const dumpGroup = (label: string, group: Record<string, number | string | null>) => {
    const entries = Object.entries(group).filter(([, v]) => v != null && v !== '');
    if (entries.length === 0) return;
    parts.push(`${label}={${entries.map(([k, v]) => `${k}:${v}`).join(', ')}}`);
  };

  dumpGroup('geo', params.geometry);
  dumpGroup('mat', params.material);
  dumpGroup('std', params.standards);
  dumpGroup('extra', params.extra);

  return parts.join(' ');
}

function formatItemLine(item: CompareItemInput): string {
  let line = `${item.position}. ${item.rawName} — ${item.quantity} ${item.unit}`;
  if (item.unitPrice != null) line += ` (цена: ${item.unitPrice})`;
  if (item.totalPrice != null) line += ` (сумма: ${item.totalPrice})`;
  line += `\n   params: ${formatParamsForPrompt(item.params)}`;
  return line;
}

/** Строит system+user сообщения для LLM-сопоставления одного батча. */
export function buildComparePrompt(
  orderItems: CompareItemInput[],
  invoiceItems: CompareItemInput[]
): ComparePromptResult {
  const orderList = orderItems.map(formatItemLine).join('\n');
  const invoiceList = invoiceItems.map(formatItemLine).join('\n');

  const userMessage = `## ЗАКАЗ (${orderItems.length} позиций)

${orderList}

## НАКЛАДНАЯ (${invoiceItems.length} позиций)

${invoiceList}

Сопоставь позиции и проверь количества. Используй извлечённые параметры (params) для принятия решений. Ответь строго в JSON-формате.`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
  };
}
