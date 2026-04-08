import type { ComparisonResult, OrderItem, InvoiceItem, SplitInfo } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Группировка результатов сравнения для таблиц.
// Цель: развернуть 1→N splits в несколько «строк счёта» внутри одной группы,
// чтобы таблицы ComparisonTableSingle / ComparisonTableBoth могли
// использовать rowSpan на колонках заказа.

export interface InvoiceRow {
  /** Может быть null, если позиция заказа не имеет соответствия в счёте (unmatched_order). */
  invoiceItem: InvoiceItem | null;
  /** Кол-во из split.byGroup[].qty или из invoiceItem.quantity. */
  quantity: number | null;
  unit: string | null;
  /** Подсистема из split.byGroup[].group, если задана. */
  groupLabel?: string | null;
}

export interface SingleGroup {
  key: string;
  /** Номер для колонки # — позиция заказа, иначе позиция счёта (unmatched_invoice). */
  position: number;
  orderItem: OrderItem | null;
  result: ComparisonResult;
  invoiceRows: InvoiceRow[];
}

export interface SideData {
  result: ComparisonResult | null;
  invoiceRows: InvoiceRow[];
}

export interface BothGroup {
  key: string;
  position: number;
  orderItem: OrderItem | null;
  llm: SideData;
  fuzzy: SideData;
  /** max(llm.invoiceRows.length, fuzzy.invoiceRows.length, 1) */
  rowSpan: number;
  /** LLM и Fuzzy разошлись по статусу или множеству invoice позиций. */
  diverged: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers

/**
 * split_json на клиенте может быть уже распарсен сервером в объект (см.
 * server/src/routes/comparisons.ts:200) либо оставлен как строка (legacy-кейс).
 * Нормализуем к объекту.
 */
function readSplit(raw: ComparisonResult['split_json']): SplitInfo | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as SplitInfo;
    } catch {
      return null;
    }
  }
  return raw;
}

/** Строим invoiceRows для одного ComparisonResult. Никогда не возвращаем пустой массив. */
function buildInvoiceRows(
  result: ComparisonResult,
  invoiceMap: Map<number, InvoiceItem>,
  invoiceByPosition: Map<number, InvoiceItem>
): InvoiceRow[] {
  // unmatched_order — нет ни одной позиции счёта.
  if (result.match_status === 'unmatched_order') {
    return [{ invoiceItem: null, quantity: null, unit: null }];
  }

  const split = readSplit(result.split_json);

  // 1→N split: разворачиваем либо по byGroup, либо по invoicePositions.
  if (split && (split.invoicePositions.length > 1 || (split.byGroup && split.byGroup.length > 0))) {
    if (split.byGroup && split.byGroup.length > 0) {
      return split.byGroup.map((g) => {
        const inv = invoiceByPosition.get(g.invoicePosition) ?? null;
        return {
          invoiceItem: inv,
          quantity: g.qty,
          unit: split.invoiceUnit,
          groupLabel: g.group,
        };
      });
    }
    return split.invoicePositions.map((pos) => {
      const inv = invoiceByPosition.get(pos) ?? null;
      return {
        invoiceItem: inv,
        quantity: inv?.quantity ?? null,
        unit: inv?.unit ?? split.invoiceUnit ?? null,
      };
    });
  }

  // Обычный 1:1 или unmatched_invoice — одна строка по invoice_item_id.
  const inv = result.invoice_item_id != null ? invoiceMap.get(result.invoice_item_id) ?? null : null;
  return [
    {
      invoiceItem: inv,
      quantity: inv?.quantity ?? null,
      unit: inv?.unit ?? null,
    },
  ];
}

/** Ключ группы — по order_item_id, либо по invoice_item_id для unmatched_invoice. */
function groupKey(result: ComparisonResult): string {
  if (result.order_item_id != null) return `order:${result.order_item_id}`;
  if (result.invoice_item_id != null) return `inv:${result.invoice_item_id}`;
  return `row:${result.id}`;
}

/** Позиция для сортировки и колонки #. */
function groupPosition(
  result: ComparisonResult,
  orderMap: Map<number, OrderItem>,
  invoiceMap: Map<number, InvoiceItem>
): number {
  if (result.order_item_id != null) {
    return orderMap.get(result.order_item_id)?.position ?? Number.MAX_SAFE_INTEGER;
  }
  if (result.invoice_item_id != null) {
    return invoiceMap.get(result.invoice_item_id)?.position ?? Number.MAX_SAFE_INTEGER;
  }
  return Number.MAX_SAFE_INTEGER;
}

// ─────────────────────────────────────────────────────────────────────────────
// groupBySingle

export function groupBySingle(
  results: ComparisonResult[],
  orderMap: Map<number, OrderItem>,
  invoiceMap: Map<number, InvoiceItem>,
  invoiceByPosition: Map<number, InvoiceItem>
): SingleGroup[] {
  const groups: SingleGroup[] = [];
  for (const result of results) {
    const orderItem = result.order_item_id != null ? orderMap.get(result.order_item_id) ?? null : null;
    groups.push({
      key: groupKey(result),
      position: groupPosition(result, orderMap, invoiceMap),
      orderItem,
      result,
      invoiceRows: buildInvoiceRows(result, invoiceMap, invoiceByPosition),
    });
  }
  groups.sort((a, b) => a.position - b.position);
  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// groupByBoth

/** Сравниваем два результата: разошлись ли они по статусу или по множеству invoice позиций. */
function hasDiverged(llm: ComparisonResult | null, fuzzy: ComparisonResult | null): boolean {
  if (!llm || !fuzzy) return llm !== fuzzy; // одна сторона есть, другой нет → разошлись
  if (llm.match_status !== fuzzy.match_status) return true;

  const llmPositions = extractInvoicePositions(llm);
  const fuzzyPositions = extractInvoicePositions(fuzzy);
  if (llmPositions.length !== fuzzyPositions.length) return true;
  for (let i = 0; i < llmPositions.length; i++) {
    if (llmPositions[i] !== fuzzyPositions[i]) return true;
  }
  return false;
}

/** Отсортированный список invoice-позиций для сравнения двух результатов. */
function extractInvoicePositions(result: ComparisonResult): number[] {
  const split = readSplit(result.split_json);
  if (split && split.invoicePositions.length > 0) {
    return [...split.invoicePositions].sort((a, b) => a - b);
  }
  // 1:1: используем invoice_item_id (не position), но для сравнения между методами
  // нам подходит любой стабильный идентификатор — сейчас это invoice_item_id.
  if (result.invoice_item_id != null) return [result.invoice_item_id];
  return [];
}

export function groupByBoth(
  results: ComparisonResult[],
  orderMap: Map<number, OrderItem>,
  invoiceMap: Map<number, InvoiceItem>,
  invoiceByPosition: Map<number, InvoiceItem>
): BothGroup[] {
  const byKey = new Map<string, BothGroup>();

  const ensure = (result: ComparisonResult): BothGroup => {
    const key = groupKey(result);
    let g = byKey.get(key);
    if (!g) {
      const orderItem = result.order_item_id != null ? orderMap.get(result.order_item_id) ?? null : null;
      g = {
        key,
        position: groupPosition(result, orderMap, invoiceMap),
        orderItem,
        llm: { result: null, invoiceRows: [] },
        fuzzy: { result: null, invoiceRows: [] },
        rowSpan: 1,
        diverged: false,
      };
      byKey.set(key, g);
    }
    return g;
  };

  for (const result of results) {
    const g = ensure(result);
    const rows = buildInvoiceRows(result, invoiceMap, invoiceByPosition);
    if (result.method === 'fuzzy') {
      g.fuzzy = { result, invoiceRows: rows };
    } else if (result.method === 'llm') {
      g.llm = { result, invoiceRows: rows };
    } else {
      // 'single' — в режиме both этого быть не должно, но на всякий случай
      // кладём в обе стороны, чтобы отрисовалось хоть что-то.
      g.llm = { result, invoiceRows: rows };
      g.fuzzy = { result, invoiceRows: rows };
    }
  }

  const groups = [...byKey.values()];
  for (const g of groups) {
    g.rowSpan = Math.max(g.llm.invoiceRows.length, g.fuzzy.invoiceRows.length, 1);
    g.diverged = hasDiverged(g.llm.result, g.fuzzy.result);
  }
  groups.sort((a, b) => a.position - b.position);
  return groups;
}
