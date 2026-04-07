/**
 * Stage A: Извлечение структурированных параметров материалов из «сырых» наименований.
 *
 * LLM получает список позиций и краткий справочник категорий из
 * server/src/data/material-categories.ts и возвращает один JSON
 * со структурированными параметрами для каждой позиции.
 *
 * Этот промпт намеренно НЕ занимается сопоставлением — только извлечением.
 * Сопоставление и классификация расхождений делаются на втором этапе
 * детерминированно (parameter-comparator.ts), поэтому модель не должна
 * «срезать углы» и сразу принимать решения о совпадениях.
 */

import {
  MATERIAL_CATEGORIES,
  type MaterialCategory,
  type ParamSpec,
} from '../data/material-categories.js';

export interface RawItemForExtraction {
  position: number;
  rawName: string;
  unit: string;
  quantity: number;
}

/** Структура, которую модель возвращает для одной позиции. */
export interface ExtractedItem {
  position: number;
  category: string;                                    // id из MATERIAL_CATEGORIES
  type: string | null;                                 // конкретный тип ("воздуховод прямоугольный")
  shape: 'round' | 'rectangular' | 'square' | null;
  geometry: Record<string, number | string | null>;
  material: Record<string, number | string | null>;
  standards: Record<string, number | string | null>;
  extra: Record<string, number | string | null>;
}

export interface ExtractResult {
  items: ExtractedItem[];
}

export interface ExtractPromptResult {
  systemPrompt: string;
  userMessage: string;
}

// ─────────────────────────────────────────────────────────────────────────────

function paramListForCategory(cat: MaterialCategory): string {
  return cat.keyParams
    .map((p: ParamSpec) => {
      const unit = p.unit ? ` [${p.unit}]` : '';
      return `      • ${p.code} (${p.group}) — ${p.label}${unit}`;
    })
    .join('\n');
}

function buildCategoryCatalog(): string {
  return MATERIAL_CATEGORIES.map((cat) => {
    const synonyms = cat.synonyms.length ? cat.synonyms.join(', ') : '—';
    return `- **${cat.id}** — ${cat.label}\n    Синонимы: ${synonyms}\n    Параметры:\n${paramListForCategory(cat)}`;
  }).join('\n\n');
}

const SYSTEM_PROMPT = `Ты — эксперт по строительным материалам и инженерному оборудованию. Твоя задача — извлечь СТРУКТУРИРОВАННЫЕ параметры из наименований позиций.

ВАЖНО: ты НЕ сопоставляешь позиции. Ты только извлекаешь параметры из каждого названия по отдельности. Сопоставление и сравнение делаются другим компонентом.

## Этап: Классификация и извлечение

Для КАЖДОЙ позиции:

1. Определи **категорию** (поле \`category\`) из справочника ниже. Если ничего не подходит — используй \`other\`.
2. Определи **type** — короткое название типа изделия в свободной форме (например: "воздуховод прямоугольный", "труба бесшовная", "уголок равнополочный").
3. Определи **shape** для изделий с поперечным сечением: \`round\`, \`rectangular\`, \`square\` или \`null\`.
4. Извлеки все применимые параметры в соответствующие группы:
   - **geometry** — размеры, диаметры, длины (числовые значения в указанных единицах)
   - **material** — марка стали, покрытие, тип материала, плотность
   - **standards** — ГОСТ, ТУ, классы, давление PN, SDR
   - **extra** — всё остальное (производитель, фасовка)

### Правила для значений
- Все геометрические размеры — в **миллиметрах** (если в источнике "м" — переведи в мм; если "см" — тоже в мм).
- Если параметр в наименовании ОТСУТСТВУЕТ — НЕ выдумывай его, оставь поле отсутствующим в JSON.
- Используй коды параметров (\`code\`) ИЗ СПРАВОЧНИКА категории, не свои. Если параметр не совпадает ни с одним кодом — добавь его в \`extra\` со своим именем.
- Числа возвращай как числа (а НЕ строки). Текстовые значения — как строки.
- Не дублируй параметр в нескольких группах.

### Расшифровка распространённых сокращений
- б/ш, бш — бесшовная | г/к, г.к. — горячекатаная | х/к, х.к. — холоднокатаная
- э/с, э.с. — электросварная | оц, оцинк — оцинкованная
- н/м — немерная длина | м/д, мерн — мерная длина
- ст. — сталь | s — толщина стенки | t — толщина
- L — длина | B/W — ширина | H — высота
- D, Ø, Ф, ДН — наружный диаметр | d, Dвн — внутренний диаметр
- DN, Ду — условный проход | PN, Ру — номинальное давление
- пр. — прямоугольный | кр. — круглый
- ВГП — водогазопроводная труба
- ПП, ПВХ, ПНД, ПЭ — полипропилен, поливинилхлорид, полиэтилен НД, полиэтилен
- НГ, Г1-Г4 — группа горючести
- А240/А400/А500С — класс арматуры

## Справочник категорий

${buildCategoryCatalog()}

## Формат ответа

Ответь ТОЛЬКО валидным JSON. Не оборачивай в \`\`\`json. Структура:

{
  "items": [
    {
      "position": 7,
      "category": "duct",
      "type": "воздуховод прямоугольный",
      "shape": "rectangular",
      "geometry": { "L": 1250, "B": 500, "H": 500 },
      "material": { "wall_thickness_mm": 1.2, "coating": "оцинкованный" },
      "standards": {},
      "extra": {}
    }
  ]
}

Поля geometry/material/standards/extra обязательны (могут быть пустыми объектами). Все 4 группы должны присутствовать.`;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Строит system+user сообщения для извлечения параметров ОДНОЙ позиции.
 *
 * Stage A идёт построчно: один LLM-вызов = одна позиция = один объект ExtractedItem
 * без обёртки `items[]`. Это даёт полную предсказуемость пайплайна и возможность
 * сохранять промежуточные результаты в БД после каждой строки.
 */
export function buildExtractParamsPromptSingle(item: RawItemForExtraction): ExtractPromptResult {
  const userMessage = `## Позиция для извлечения параметров

Позиция: ${item.position}
Наименование: ${item.rawName}
Количество: ${item.quantity}
Единица: ${item.unit}

Извлеки структурированные параметры согласно справочнику. Верни ОДИН JSON-объект (без обёртки items[]) в формате:

{
  "position": ${item.position},
  "category": "...",
  "type": "...",
  "shape": null,
  "geometry": {},
  "material": {},
  "standards": {},
  "extra": {}
}

Все 4 группы (geometry/material/standards/extra) обязательны, могут быть пустыми объектами.`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
  };
}

/**
 * Строит system+user сообщения для извлечения параметров СРАЗУ N позиций в одном LLM-вызове.
 *
 * Критично: чтобы модель не перепутала строки между собой, каждая позиция оборачивается
 * явными маркерами `=== POSITION N ===` / `=== END POSITION N ===`, а в инструкции
 * жёстко требуется сохранить порядок и точные номера position.
 *
 * Ответ должен быть строго `{ "items": [ { position, ... }, ... ] }`,
 * по одному элементу на каждую входную POSITION, в том же порядке.
 */
export function buildExtractParamsPromptBatch(items: RawItemForExtraction[]): ExtractPromptResult {
  const expectedPositions = items.map((it) => it.position);

  const blocks = items
    .map((it) => {
      return [
        `=== POSITION ${it.position} ===`,
        `position: ${it.position}`,
        `name: ${it.rawName}`,
        `quantity: ${it.quantity}`,
        `unit: ${it.unit}`,
        `=== END POSITION ${it.position} ===`,
      ].join('\n');
    })
    .join('\n\n');

  const userMessage = `## Извлечение параметров для пакета из ${items.length} позиций

СТРОГИЕ ПРАВИЛА (нарушение = ошибка):
1. Верни РОВНО ${items.length} элементов в массиве "items", по одному на каждую входную POSITION.
2. Поле "position" в каждом ответе ДОЛЖНО точно совпадать с номером входной POSITION. Запрещено объединять, переименовывать, переупорядочивать или пропускать позиции.
3. Параметры одной POSITION извлекаются ИСКЛЮЧИТЕЛЬНО из её блока (между маркерами === POSITION N === и === END POSITION N ===). Не подсматривай в соседние блоки и не переноси параметры между ними.
4. Порядок элементов в "items[]" должен СТРОГО соответствовать порядку входных POSITION.
5. Если в наименовании какой-то позиции параметра нет — НЕ выдумывай, оставь поле отсутствующим. Все 4 группы (geometry/material/standards/extra) обязательны как объекты, могут быть пустыми.

Ожидаемые position (ровно в этом порядке): [${expectedPositions.join(', ')}]

## Позиции

${blocks}

## Формат ответа

Только валидный JSON, без markdown-обёртки:

{
  "items": [
    { "position": ${expectedPositions[0]}, "category": "...", "type": "...", "shape": null, "geometry": {}, "material": {}, "standards": {}, "extra": {} }${items.length > 1 ? ',\n    ...' : ''}
  ]
}`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
  };
}
