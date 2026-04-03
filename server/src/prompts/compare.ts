/**
 * Builds the system prompt and user message for the merged
 * normalization + comparison step.
 */

export interface CompareItemInput {
  position: number;
  rawName: string;
  unit: string;
  quantity: number;
  unitPrice?: number;
  totalPrice?: number;
}

export interface ComparePromptResult {
  systemPrompt: string;
  userMessage: string;
}

const SYSTEM_PROMPT = `Ты — эксперт по строительным материалам. Твоя задача — нормализовать наименования материалов из заказа и накладной, а затем сопоставить позиции между ними.

## Этап 1: Нормализация наименований

Для каждой позиции из обоих списков выдели:
- **Тип материала** (труба, лист, уголок, швеллер, арматура, балка, профнастил, утеплитель, пиломатериал и т.д.)
- **Размеры**: диаметр, толщина стенки, ширина, высота, длина, толщина (в мм)
- **Марка стали / материала**: Ст3, 09Г2С, 3сп/пс, AISI 304 и т.д.
- **ГОСТ / ТУ**: ГОСТ 8732-78, ГОСТ 8240-97 и т.д.
- **Особенности**: покрытие (оцинкованная, грунтованная), обработка

### Расшифровка сокращений:
- б/ш, бш — бесшовная
- г/к, г.к., горячекат — горячекатаная
- х/к, х.к., холоднокат — холоднокатаная
- э/с, э.с., электросв — электросварная
- оц, оцинк — оцинкованная
- н/м, н.м. — немерной длины
- м/д, мерн — мерной длины
- ст. — сталь
- s — толщина стенки
- t — толщина

## Этап 2: Сопоставление позиций

Сопоставляй позиции заказа с позициями накладной по:
1. **Тип материала** — должен совпадать
2. **Ключевые размеры** — диаметр, толщина стенки, ширина, высота (допуск ±1мм для проката)
3. **ГОСТ / ТУ** — если указан в обоих документах, должен совпадать
4. **Марка стали** — если указана

### Правила сопоставления:
- Одна позиция заказа может соответствовать одной позиции накладной (1:1)
- Если точного совпадения нет — ищи ближайшее с указанием расхождений
- Доверие (match_confidence): 1.0 = идеальное совпадение, 0.8+ = совпадает с мелкими различиями, 0.5-0.8 = вероятное совпадение с расхождениями, <0.5 = сомнительное совпадение

## Этап 3: Проверка количества

Сравни количества с учётом единиц измерения:
- кг ↔ т (1 т = 1000 кг)
- м² ↔ 100м² (кровельные материалы, 1 × 100м² = 100 м²)
- м.п. ↔ шт (если известна длина штуки, пересчитай)
- м³ ↔ м³ (прямое сравнение)

### Статусы количества:
- **exact** — разница 0%
- **within_tolerance** — разница ≤ 5%
- **over** — в накладной больше, чем в заказе, разница > 5%
- **under** — в накладной меньше, чем в заказе, разница > 5%
- **incompatible_units** — единицы нельзя привести друг к другу без дополнительных данных

## Этап 4: Классификация расхождений

Для каждого сопоставленного элемента укажи расхождения параметров:

Severity уровни:
- **critical** — неправильные размеры, марка стали, тип материала (может повлиять на конструкцию)
- **warning** — другой бренд при тех же характеристиках, отличие ГОСТа при совпадении параметров
- **info** — различия в форматировании, сокращениях, порядке слов

## Формат ответа

Ответь ТОЛЬКО валидным JSON без markdown-обёртки:

{
  "matched_items": [
    {
      "order_row": 1,
      "invoice_row": 3,
      "order_name": "исходное наименование из заказа",
      "invoice_name": "исходное наименование из накладной",
      "normalized_name": "нормализованное общее название",
      "match_confidence": 0.95,
      "match_reasoning": "пояснение почему сопоставлены",
      "parameter_mismatches": [
        {
          "parameter": "название параметра",
          "order_value": "значение в заказе",
          "invoice_value": "значение в накладной",
          "severity": "critical | warning | info"
        }
      ],
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
    {
      "order_row": 5,
      "order_name": "наименование из заказа",
      "reason": "причина почему не найдено совпадение"
    }
  ],
  "unmatched_invoice": [
    {
      "invoice_row": 7,
      "invoice_name": "наименование из накладной",
      "reason": "причина почему не найдено совпадение"
    }
  ],
  "summary": {
    "total_order": 10,
    "total_invoice": 12,
    "matched": 8,
    "unmatched_order": 2,
    "unmatched_invoice": 4,
    "critical_mismatches": 1,
    "warnings": 3
  }
}`;

/**
 * Builds the system prompt and user message for the comparison step.
 */
export function buildComparePrompt(
  orderItems: CompareItemInput[],
  invoiceItems: CompareItemInput[]
): ComparePromptResult {
  const orderList = orderItems.map((item) => {
    let line = `${item.position}. ${item.rawName} — ${item.quantity} ${item.unit}`;
    if (item.unitPrice != null) line += ` (цена: ${item.unitPrice})`;
    if (item.totalPrice != null) line += ` (сумма: ${item.totalPrice})`;
    return line;
  }).join('\n');

  const invoiceList = invoiceItems.map((item) => {
    let line = `${item.position}. ${item.rawName} — ${item.quantity} ${item.unit}`;
    if (item.unitPrice != null) line += ` (цена: ${item.unitPrice})`;
    if (item.totalPrice != null) line += ` (сумма: ${item.totalPrice})`;
    return line;
  }).join('\n');

  const userMessage = `## ЗАКАЗ (${orderItems.length} позиций)

${orderList}

## НАКЛАДНАЯ (${invoiceItems.length} позиций)

${invoiceList}

Нормализуй наименования, сопоставь позиции и проверь количества. Ответь строго в JSON формате.`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
  };
}
