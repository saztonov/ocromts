/**
 * Справочник категорий материалов и их параметров.
 *
 * Универсальный декларативный источник истины для:
 *  - LLM-извлечения параметров (Stage A)  — server/src/services/parameter-extractor.ts
 *  - Детерминированного сопоставления (Stage B) — server/src/services/parameter-comparator.ts
 *  - UI side-by-side таблицы параметров — client/src/components/comparison/MaterialRow.tsx
 *
 * Чтобы добавить новую категорию материала или новый параметр — отредактируйте этот файл.
 * Никаких других изменений в логике сравнения, БД или UI не требуется.
 *
 * Источник содержательного каталога: AGENTS/prompts/normalizer-matcher.md (раздел 1.2).
 */

export type ParamGroup = 'geometry' | 'material' | 'standards' | 'extra';
export type Severity = 'critical' | 'warning' | 'info';

export type Tolerance =
  | { type: 'exact' }                  // строгое совпадение строки/числа
  | { type: 'abs'; value: number }     // абсолютный допуск (мм / ед.)
  | { type: 'pct'; value: number };    // относительный допуск (%)

export interface ParamSpec {
  /** Машинный код параметра, ключ в JSON (`L`, `D`, `wall_thickness_mm`, `grade`, ...) */
  code: string;
  /** Человекочитаемое название (русский, для UI и LLM-промпта) */
  label: string;
  /** Группа для side-by-side таблицы в UI */
  group: ParamGroup;
  /** Единица измерения, если применимо */
  unit?: string;
  /** Тяжесть расхождения по умолчанию (категория может переопределить per-param) */
  severity: Severity;
  /** Правило допуска при сравнении значений */
  tolerance: Tolerance;
}

export interface MaterialCategory {
  /** Машинный идентификатор категории (используется в `params_json.category`) */
  id: string;
  /** Человекочитаемое название (для UI и LLM) */
  label: string;
  /** Синонимы / варианты написания типа изделия — помогают LLM выбрать категорию */
  synonyms: string[];
  /** true → форма сечения (round/rectangular/square) считается критичной */
  shapeMatters: boolean;
  /** Параметры категории */
  keyParams: ParamSpec[];
  /**
   * Коды параметров, образующих неупорядоченную размерную группу.
   * Например: для прямоугольного воздуховода `['B','H']` означает, что
   * сечение 250×600 эквивалентно 600×250. Нормализатор отсортирует
   * значения этих кодов по возрастанию и запишет их обратно в исходные ключи.
   * Используется только если все коды в одной группе (`geometry`/...) и
   * соответствующие значения числовые. Должно содержать параметры с одинаковой
   * единицей измерения, иначе сортировка бессмысленна.
   */
  unorderedDims?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────

/** Универсальные параметры стандартов — добавляются ко многим категориям */
const STANDARD_GOST: ParamSpec = {
  code: 'gost',
  label: 'ГОСТ / ТУ',
  group: 'standards',
  severity: 'warning',
  tolerance: { type: 'exact' },
};

const STANDARD_GRADE: ParamSpec = {
  code: 'grade',
  label: 'Марка / сорт',
  group: 'material',
  severity: 'critical',
  tolerance: { type: 'exact' },
};

const STANDARD_COATING: ParamSpec = {
  code: 'coating',
  label: 'Покрытие',
  group: 'material',
  severity: 'warning',
  tolerance: { type: 'exact' },
};

const STANDARD_BRAND: ParamSpec = {
  code: 'brand',
  label: 'Бренд / производитель',
  group: 'extra',
  severity: 'info',
  tolerance: { type: 'exact' },
};

// ─────────────────────────────────────────────────────────────────────────────

export const MATERIAL_CATEGORIES: MaterialCategory[] = [
  // ── Воздуховоды ────────────────────────────────────────────────────────────
  {
    id: 'duct',
    label: 'Воздуховод',
    synonyms: ['воздуховод', 'короб', 'duct'],
    shapeMatters: true,
    unorderedDims: ['B', 'H'],
    keyParams: [
      { code: 'L',                 group: 'geometry', label: 'Длина',          unit: 'мм', severity: 'critical', tolerance: { type: 'abs', value: 50 } },
      { code: 'D',                 group: 'geometry', label: 'Диаметр',        unit: 'мм', severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'B',                 group: 'geometry', label: 'Ширина сечения', unit: 'мм', severity: 'critical', tolerance: { type: 'abs', value: 1 } },
      { code: 'H',                 group: 'geometry', label: 'Высота сечения', unit: 'мм', severity: 'critical', tolerance: { type: 'abs', value: 1 } },
      { code: 'wall_thickness_mm', group: 'material', label: 'Толщина стенки', unit: 'мм', severity: 'warning',  tolerance: { type: 'abs', value: 0.05 } },
      STANDARD_COATING,
      STANDARD_BRAND,
    ],
  },

  // ── Фитинги воздуховодов (отвод, тройник, переход) ─────────────────────────
  {
    id: 'duct_fitting',
    label: 'Фитинг воздуховода',
    synonyms: ['отвод', 'тройник', 'переход', 'заслонка', 'клапан', 'фланец', 'муфта воздуховода'],
    shapeMatters: true,
    unorderedDims: ['B', 'H'],
    keyParams: [
      { code: 'D',                 group: 'geometry', label: 'Диаметр',        unit: 'мм', severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'B',                 group: 'geometry', label: 'Ширина сечения', unit: 'мм', severity: 'critical', tolerance: { type: 'abs', value: 1 } },
      { code: 'H',                 group: 'geometry', label: 'Высота сечения', unit: 'мм', severity: 'critical', tolerance: { type: 'abs', value: 1 } },
      { code: 'angle_deg',         group: 'geometry', label: 'Угол',           unit: '°',  severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'wall_thickness_mm', group: 'material', label: 'Толщина стенки', unit: 'мм', severity: 'warning',  tolerance: { type: 'abs', value: 0.05 } },
      STANDARD_COATING,
    ],
  },

  // ── Стальные трубы ─────────────────────────────────────────────────────────
  {
    id: 'pipe_steel',
    label: 'Труба стальная',
    synonyms: ['труба стальная', 'труба бесшовная', 'труба электросварная', 'труба ВГП', 'труба профильная', 'б/ш', 'э/с'],
    shapeMatters: false,
    unorderedDims: ['B', 'H'],
    keyParams: [
      { code: 'D',                 group: 'geometry', label: 'Наружный диаметр', unit: 'мм', severity: 'critical', tolerance: { type: 'abs', value: 1 } },
      { code: 'wall_thickness_mm', group: 'geometry', label: 'Толщина стенки',   unit: 'мм', severity: 'critical', tolerance: { type: 'abs', value: 0.2 } },
      { code: 'L',                 group: 'geometry', label: 'Длина',            unit: 'мм', severity: 'warning',  tolerance: { type: 'abs', value: 50 } },
      { code: 'B',                 group: 'geometry', label: 'Ширина профиля',   unit: 'мм', severity: 'critical', tolerance: { type: 'abs', value: 1 } },
      { code: 'H',                 group: 'geometry', label: 'Высота профиля',   unit: 'мм', severity: 'critical', tolerance: { type: 'abs', value: 1 } },
      { code: 'production',        group: 'material', label: 'Способ изготовления',           severity: 'warning',  tolerance: { type: 'exact' } },
      STANDARD_GRADE,
      STANDARD_GOST,
    ],
  },

  // ── Инженерные трубы (ПП, ПВХ, ПНД, медь) ─────────────────────────────────
  {
    id: 'pipe_engineering',
    label: 'Труба инженерная',
    synonyms: ['труба пп', 'труба пвх', 'труба пнд', 'труба полипропилен', 'труба медная', 'труба пэ'],
    shapeMatters: false,
    keyParams: [
      { code: 'material_type',     group: 'material', label: 'Материал',                      severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'D',                 group: 'geometry', label: 'Наружный диаметр', unit: 'мм', severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'wall_thickness_mm', group: 'geometry', label: 'Толщина стенки',   unit: 'мм', severity: 'warning',  tolerance: { type: 'abs', value: 0.1 } },
      { code: 'pn_bar',            group: 'standards', label: 'PN (давление)',  unit: 'бар', severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'sdr',               group: 'standards', label: 'SDR',                          severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'L',                 group: 'geometry',  label: 'Длина',          unit: 'мм',  severity: 'warning',  tolerance: { type: 'abs', value: 50 } },
    ],
  },

  // ── Листы и полосы металлопроката ─────────────────────────────────────────
  {
    id: 'sheet_metal',
    label: 'Лист металлический',
    synonyms: ['лист', 'полоса', 'г/к лист', 'х/к лист', 'рифлёный лист', 'просечно-вытяжной'],
    shapeMatters: false,
    unorderedDims: ['L', 'B'],
    keyParams: [
      { code: 'thickness_mm', group: 'geometry', label: 'Толщина', unit: 'мм', severity: 'critical', tolerance: { type: 'abs', value: 0.1 } },
      { code: 'B',            group: 'geometry', label: 'Ширина',  unit: 'мм', severity: 'warning',  tolerance: { type: 'abs', value: 5 } },
      { code: 'L',            group: 'geometry', label: 'Длина',   unit: 'мм', severity: 'warning',  tolerance: { type: 'abs', value: 5 } },
      { code: 'production',   group: 'material', label: 'Способ изготовления',            severity: 'warning',  tolerance: { type: 'exact' } },
      STANDARD_GRADE,
      STANDARD_GOST,
    ],
  },

  // ── Фасонный прокат (уголок, швеллер, двутавр, балка) ──────────────────────
  {
    id: 'profile_steel',
    label: 'Фасонный прокат',
    synonyms: ['уголок', 'швеллер', 'двутавр', 'балка', 'тавр', 'шпунт'],
    shapeMatters: false,
    keyParams: [
      { code: 'profile_number', group: 'geometry', label: 'Номер профиля',                severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'B',              group: 'geometry', label: 'Ширина полки', unit: 'мм',     severity: 'critical', tolerance: { type: 'abs', value: 1 } },
      { code: 'H',              group: 'geometry', label: 'Высота',       unit: 'мм',     severity: 'critical', tolerance: { type: 'abs', value: 1 } },
      { code: 'flange_thickness_mm', group: 'geometry', label: 'Толщина полки', unit: 'мм', severity: 'warning', tolerance: { type: 'abs', value: 0.3 } },
      { code: 'web_thickness_mm',    group: 'geometry', label: 'Толщина стенки', unit: 'мм', severity: 'warning', tolerance: { type: 'abs', value: 0.3 } },
      { code: 'L',              group: 'geometry', label: 'Длина',        unit: 'мм',     severity: 'warning',  tolerance: { type: 'abs', value: 50 } },
      { code: 'profile_type',   group: 'extra',    label: 'Тип профиля',                  severity: 'warning',  tolerance: { type: 'exact' } },
      STANDARD_GRADE,
      STANDARD_GOST,
    ],
  },

  // ── Арматура ───────────────────────────────────────────────────────────────
  {
    id: 'rebar',
    label: 'Арматура',
    synonyms: ['арматура', 'стержневая', 'периодического профиля', 'гладкая'],
    shapeMatters: false,
    keyParams: [
      { code: 'D',           group: 'geometry', label: 'Диаметр',         unit: 'мм', severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'rebar_class', group: 'standards', label: 'Класс арматуры',             severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'profile',     group: 'extra',    label: 'Профиль',                     severity: 'warning',  tolerance: { type: 'exact' } },
      { code: 'L',           group: 'geometry', label: 'Длина',           unit: 'мм', severity: 'info',     tolerance: { type: 'abs', value: 100 } },
      STANDARD_GOST,
    ],
  },

  // ── Профнастил и металлочерепица ───────────────────────────────────────────
  {
    id: 'profnastil',
    label: 'Профнастил',
    synonyms: ['профнастил', 'профлист', 'металлочерепица', 'С8', 'С21', 'НС35', 'Н60', 'Н75', 'Н114'],
    shapeMatters: false,
    unorderedDims: ['L', 'B'],
    keyParams: [
      { code: 'profile_mark',  group: 'geometry', label: 'Марка профиля',                 severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'thickness_mm',  group: 'geometry', label: 'Толщина металла', unit: 'мм',   severity: 'critical', tolerance: { type: 'abs', value: 0.05 } },
      { code: 'B',             group: 'geometry', label: 'Рабочая ширина',  unit: 'мм',   severity: 'warning',  tolerance: { type: 'abs', value: 5 } },
      { code: 'L',             group: 'geometry', label: 'Длина',           unit: 'мм',   severity: 'warning',  tolerance: { type: 'abs', value: 50 } },
      STANDARD_COATING,
      { code: 'ral',           group: 'material', label: 'Цвет (RAL)',                    severity: 'warning',  tolerance: { type: 'exact' } },
    ],
  },

  // ── Бетон и ЖБИ ────────────────────────────────────────────────────────────
  {
    id: 'concrete',
    label: 'Бетон / ЖБИ',
    synonyms: ['бетон', 'ЖБИ', 'плита перекрытия', 'фбс', 'фундаментный блок'],
    shapeMatters: false,
    unorderedDims: ['L', 'B', 'H'],
    keyParams: [
      { code: 'strength_class', group: 'material', label: 'Класс прочности (B)',           severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'mark_legacy',    group: 'material', label: 'Марка (M)',                     severity: 'warning',  tolerance: { type: 'exact' } },
      { code: 'frost_class',    group: 'material', label: 'Морозостойкость (F)',           severity: 'warning',  tolerance: { type: 'exact' } },
      { code: 'water_class',    group: 'material', label: 'Водонепроницаемость (W)',       severity: 'warning',  tolerance: { type: 'exact' } },
      { code: 'mobility',       group: 'material', label: 'Подвижность (П)',               severity: 'info',     tolerance: { type: 'exact' } },
      { code: 'L',              group: 'geometry', label: 'Длина',           unit: 'мм',   severity: 'critical', tolerance: { type: 'abs', value: 5 } },
      { code: 'B',              group: 'geometry', label: 'Ширина',          unit: 'мм',   severity: 'critical', tolerance: { type: 'abs', value: 5 } },
      { code: 'H',              group: 'geometry', label: 'Высота',          unit: 'мм',   severity: 'critical', tolerance: { type: 'abs', value: 5 } },
    ],
  },

  // ── Кирпич и блоки ─────────────────────────────────────────────────────────
  {
    id: 'brick_block',
    label: 'Кирпич / блок',
    synonyms: ['кирпич', 'блок', 'газобетон', 'пенобетон', 'газоблок'],
    shapeMatters: false,
    unorderedDims: ['L', 'B', 'H'],
    keyParams: [
      { code: 'material_type',  group: 'material', label: 'Тип',                          severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'mark_strength',  group: 'material', label: 'Марка прочности (M)',          severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'frost_class',    group: 'material', label: 'Морозостойкость (F)',          severity: 'warning',  tolerance: { type: 'exact' } },
      { code: 'density',        group: 'material', label: 'Плотность (D)', unit: 'кг/м³', severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'L',              group: 'geometry', label: 'Длина',         unit: 'мм',    severity: 'critical', tolerance: { type: 'abs', value: 2 } },
      { code: 'B',              group: 'geometry', label: 'Ширина',        unit: 'мм',    severity: 'critical', tolerance: { type: 'abs', value: 2 } },
      { code: 'H',              group: 'geometry', label: 'Высота',        unit: 'мм',    severity: 'critical', tolerance: { type: 'abs', value: 2 } },
      { code: 'voidness',       group: 'extra',    label: 'Пустотность',                  severity: 'warning',  tolerance: { type: 'exact' } },
    ],
  },

  // ── Утеплители и изоляция ─────────────────────────────────────────────────
  {
    id: 'insulation',
    label: 'Утеплитель',
    synonyms: ['утеплитель', 'минвата', 'пенополистирол', 'XPS', 'EPS', 'PIR', 'ППУ', 'пеноплекс', 'пеноплэкс', 'базальт'],
    shapeMatters: false,
    unorderedDims: ['L', 'B'],
    keyParams: [
      { code: 'material_type',     group: 'material', label: 'Тип утеплителя',              severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'density',           group: 'material', label: 'Плотность',     unit: 'кг/м³', severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'thickness_mm',      group: 'geometry', label: 'Толщина',       unit: 'мм',    severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'L',                 group: 'geometry', label: 'Длина плиты',   unit: 'мм',    severity: 'warning',  tolerance: { type: 'abs', value: 5 } },
      { code: 'B',                 group: 'geometry', label: 'Ширина плиты',  unit: 'мм',    severity: 'warning',  tolerance: { type: 'abs', value: 5 } },
      { code: 'thermal_conductivity', group: 'material', label: 'Теплопроводность (λ)', unit: 'Вт/(м·К)', severity: 'critical', tolerance: { type: 'pct', value: 5 } },
      { code: 'flammability',      group: 'standards', label: 'Группа горючести',           severity: 'critical', tolerance: { type: 'exact' } },
      STANDARD_BRAND,
    ],
  },

  // ── Гидроизоляция и кровля ────────────────────────────────────────────────
  {
    id: 'waterproofing',
    label: 'Гидроизоляция',
    synonyms: ['гидроизоляция', 'наплавляемая', 'мембрана', 'техноэласт', 'бикрост', 'унифлекс', 'биполь', 'ЭПП', 'ЭКП'],
    shapeMatters: false,
    keyParams: [
      { code: 'material_type', group: 'material', label: 'Тип',                             severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'thickness_mm',  group: 'geometry', label: 'Толщина',           unit: 'мм',  severity: 'critical', tolerance: { type: 'abs', value: 0.1 } },
      { code: 'B',             group: 'geometry', label: 'Ширина рулона',     unit: 'мм',  severity: 'warning',  tolerance: { type: 'abs', value: 10 } },
      { code: 'L',             group: 'geometry', label: 'Длина рулона',      unit: 'м',   severity: 'warning',  tolerance: { type: 'abs', value: 0.5 } },
      { code: 'base',          group: 'material', label: 'Основа',                          severity: 'warning',  tolerance: { type: 'exact' } },
      { code: 'modification',  group: 'material', label: 'Модификация',                     severity: 'warning',  tolerance: { type: 'exact' } },
      STANDARD_BRAND,
    ],
  },

  // ── Пиломатериалы ──────────────────────────────────────────────────────────
  {
    id: 'lumber',
    label: 'Пиломатериал',
    synonyms: ['доска', 'брус', 'брусок', 'рейка', 'вагонка', 'фанера', 'OSB', 'ДСП', 'ОСБ'],
    shapeMatters: false,
    unorderedDims: ['B', 'H'],
    keyParams: [
      { code: 'lumber_type', group: 'material', label: 'Тип',                              severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'wood_species',group: 'material', label: 'Порода',                           severity: 'warning',  tolerance: { type: 'exact' } },
      { code: 'B',           group: 'geometry', label: 'Сечение (ширина)', unit: 'мм',     severity: 'critical', tolerance: { type: 'abs', value: 2 } },
      { code: 'H',           group: 'geometry', label: 'Сечение (высота)', unit: 'мм',     severity: 'critical', tolerance: { type: 'abs', value: 2 } },
      { code: 'thickness_mm',group: 'geometry', label: 'Толщина',          unit: 'мм',     severity: 'critical', tolerance: { type: 'abs', value: 0.5 } },
      { code: 'L',           group: 'geometry', label: 'Длина',            unit: 'мм',     severity: 'warning',  tolerance: { type: 'abs', value: 100 } },
      { code: 'sort',        group: 'standards', label: 'Сорт',                            severity: 'warning',  tolerance: { type: 'exact' } },
      { code: 'humidity',    group: 'material', label: 'Влажность',                        severity: 'info',     tolerance: { type: 'exact' } },
      { code: 'plywood_grade',group: 'standards', label: 'Класс (фанера)',                 severity: 'warning',  tolerance: { type: 'exact' } },
    ],
  },

  // ── Сухие смеси, клеи ─────────────────────────────────────────────────────
  {
    id: 'dry_mix',
    label: 'Сухая смесь',
    synonyms: ['штукатурка', 'шпаклёвка', 'клей плиточный', 'наливной пол', 'затирка', 'ротбанд', 'ветонит', 'церезит', 'кнауф'],
    shapeMatters: false,
    keyParams: [
      { code: 'mix_type',   group: 'material', label: 'Тип смеси',                  severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'series',     group: 'material', label: 'Марка / серия',              severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'base',       group: 'material', label: 'Основа',                     severity: 'warning',  tolerance: { type: 'exact' } },
      { code: 'package_kg', group: 'extra',    label: 'Фасовка', unit: 'кг',        severity: 'info',     tolerance: { type: 'exact' } },
      STANDARD_BRAND,
    ],
  },

  // ── Краски, грунтовки, лаки ────────────────────────────────────────────────
  {
    id: 'paint',
    label: 'Краска / грунт',
    synonyms: ['краска', 'грунтовка', 'грунт', 'эмаль', 'лак', 'пропитка'],
    shapeMatters: false,
    keyParams: [
      { code: 'paint_type', group: 'material', label: 'Тип',                       severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'base',       group: 'material', label: 'Основа',                    severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'ral',        group: 'material', label: 'Цвет (RAL)',                severity: 'warning',  tolerance: { type: 'exact' } },
      { code: 'volume_l',   group: 'extra',    label: 'Объём',  unit: 'л',         severity: 'info',     tolerance: { type: 'exact' } },
      { code: 'mass_kg',    group: 'extra',    label: 'Масса', unit: 'кг',         severity: 'info',     tolerance: { type: 'exact' } },
      STANDARD_BRAND,
    ],
  },

  // ── Кабельная продукция ────────────────────────────────────────────────────
  {
    id: 'cable',
    label: 'Кабель',
    synonyms: ['кабель', 'провод', 'ВВГнг', 'NYM', 'ПВС', 'КГ', 'СИП'],
    shapeMatters: false,
    keyParams: [
      { code: 'cable_mark',  group: 'material', label: 'Марка кабеля',              severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'cores_count', group: 'geometry', label: 'Число жил',                 severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'cross_section_mm2', group: 'geometry', label: 'Сечение жилы', unit: 'мм²', severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'voltage_kv',  group: 'standards', label: 'Напряжение',  unit: 'кВ',  severity: 'warning',  tolerance: { type: 'exact' } },
      { code: 'fire_class',  group: 'standards', label: 'Огнестойкость',             severity: 'warning',  tolerance: { type: 'exact' } },
    ],
  },

  // ── Крепёж и метизы ────────────────────────────────────────────────────────
  {
    id: 'fastener',
    label: 'Крепёж',
    synonyms: ['болт', 'гайка', 'шуруп', 'саморез', 'анкер', 'дюбель', 'шпилька', 'заклёпка', 'винт'],
    shapeMatters: false,
    keyParams: [
      { code: 'fastener_type',   group: 'material', label: 'Тип',                          severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'thread_size',     group: 'geometry', label: 'Размер резьбы (M)',            severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'L',               group: 'geometry', label: 'Длина',           unit: 'мм',  severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'D',               group: 'geometry', label: 'Диаметр (саморез)', unit: 'мм',severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'strength_class',  group: 'standards', label: 'Класс прочности',             severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'material_type',   group: 'material', label: 'Материал',                     severity: 'warning',  tolerance: { type: 'exact' } },
      STANDARD_COATING,
    ],
  },

  // ── Стекло и стеклопакеты ─────────────────────────────────────────────────
  {
    id: 'glass',
    label: 'Стекло',
    synonyms: ['стекло', 'стеклопакет', 'триплекс', 'закалённое'],
    shapeMatters: false,
    unorderedDims: ['B', 'H'],
    keyParams: [
      { code: 'glass_type',   group: 'material', label: 'Тип',                       severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'thickness_mm', group: 'geometry', label: 'Толщина',     unit: 'мм',   severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'B',            group: 'geometry', label: 'Ширина',      unit: 'мм',   severity: 'warning',  tolerance: { type: 'abs', value: 2 } },
      { code: 'H',            group: 'geometry', label: 'Высота',      unit: 'мм',   severity: 'warning',  tolerance: { type: 'abs', value: 2 } },
      { code: 'pack_formula', group: 'extra',    label: 'Формула пакета',            severity: 'warning',  tolerance: { type: 'exact' } },
    ],
  },

  // ── Сантехника / оборудование ─────────────────────────────────────────────
  {
    id: 'sanitary',
    label: 'Сантехника / оборудование',
    synonyms: ['унитаз', 'раковина', 'ванна', 'смеситель', 'радиатор', 'насос', 'котёл', 'бойлер'],
    shapeMatters: false,
    keyParams: [
      { code: 'product_type', group: 'material', label: 'Тип',                       severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'model',        group: 'material', label: 'Модель',                    severity: 'warning',  tolerance: { type: 'exact' } },
      { code: 'connection',   group: 'standards', label: 'Присоединение (DN)',       severity: 'critical', tolerance: { type: 'exact' } },
      { code: 'power_kw',     group: 'standards', label: 'Мощность',     unit: 'кВт',severity: 'critical', tolerance: { type: 'pct', value: 5 } },
      { code: 'pressure_pn',  group: 'standards', label: 'Давление (PN)', unit: 'бар',severity: 'warning',  tolerance: { type: 'exact' } },
      STANDARD_BRAND,
    ],
  },

  // ── Универсальная fallback-категория ──────────────────────────────────────
  // Используется когда LLM не смог отнести позицию ни к одной известной категории.
  // Сравнение тогда — только по типу + ключевым размерам, если они есть.
  {
    id: 'other',
    label: 'Прочее',
    synonyms: [],
    shapeMatters: false,
    unorderedDims: ['L', 'B', 'H'],
    keyParams: [
      { code: 'L', group: 'geometry', label: 'Длина',  unit: 'мм', severity: 'warning', tolerance: { type: 'abs', value: 5 } },
      { code: 'B', group: 'geometry', label: 'Ширина', unit: 'мм', severity: 'warning', tolerance: { type: 'abs', value: 5 } },
      { code: 'H', group: 'geometry', label: 'Высота', unit: 'мм', severity: 'warning', tolerance: { type: 'abs', value: 5 } },
      { code: 'D', group: 'geometry', label: 'Диаметр',unit: 'мм', severity: 'warning', tolerance: { type: 'abs', value: 1 } },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────

/** Быстрый поиск категории по id; вернёт `other` если категория неизвестна. */
export function findCategory(id: string | null | undefined): MaterialCategory {
  if (id) {
    const found = MATERIAL_CATEGORIES.find((c) => c.id === id);
    if (found) return found;
  }
  return MATERIAL_CATEGORIES.find((c) => c.id === 'other')!;
}

/** Все доступные id категорий — для подачи в LLM-промпт. */
export function listCategoryIds(): string[] {
  return MATERIAL_CATEGORIES.map((c) => c.id);
}
