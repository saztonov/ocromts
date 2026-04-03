#!/usr/bin/env node
/**
 * Конвертация comparison.json в Markdown-отчёт.
 * Вызов: node to-markdown.js <comparison.json> [output.md]
 */

const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node to-markdown.js <comparison.json> [output.md]');
  process.exit(1);
}

const outputPath = process.argv[3] || inputPath.replace(/\.json$/, '.md').replace('comparison', 'report');
const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

const lines = [];
const s = data.summary || {};
const meta = data.metadata || {};

// --- Заголовок ---
lines.push('# Отчёт о сверке заказа и накладной');
lines.push('');
lines.push(`| Параметр | Значение |`);
lines.push(`|----------|----------|`);
lines.push(`| Файл заказа | ${meta.order_file || '—'} |`);
lines.push(`| Файл накладной | ${meta.invoice_file || '—'} |`);
lines.push(`| Тип накладной | ${meta.invoice_type || '—'} |`);
lines.push(`| Дата сверки | ${meta.comparison_date || '—'} |`);
lines.push(`| Папка | ${meta.folder || '—'} |`);
lines.push('');

// --- Сводка ---
lines.push('## Сводка');
lines.push('');
lines.push('| Показатель | Значение |');
lines.push('|------------|----------|');
lines.push(`| Всего позиций заказа | ${s.total_order || 0} |`);
lines.push(`| Всего позиций накладной | ${s.total_invoice || 0} |`);
lines.push(`| Сопоставлено | **${s.matched || 0}** |`);
lines.push(`| Не найдено в накладной | ${s.unmatched_order || 0} |`);
lines.push(`| Лишнее в накладной | ${s.unmatched_invoice || 0} |`);
lines.push(`| Критичных расхождений | ${s.critical_mismatches ? '**' + s.critical_mismatches + '**' : '0'} |`);
lines.push(`| Предупреждений | ${s.warnings || 0} |`);
lines.push('');

// --- Сопоставленные позиции ---
const matched = data.matched_items || [];
if (matched.length > 0) {
  lines.push('## Сопоставленные позиции');
  lines.push('');
  lines.push('| № заказа | № накл. | Наименование | Кол-во заказ | Кол-во накл. | Разница | Статус |');
  lines.push('|----------|---------|-------------|-------------|-------------|---------|--------|');

  for (const item of matched) {
    const qc = item.quantity_comparison || {};
    const diffStr = qc.difference_pct != null ? `${qc.difference_pct}%` : '—';
    const statusIcon = getStatusIcon(qc.status);

    lines.push(
      `| ${item.order_row} | ${item.invoice_row} ` +
      `| ${truncate(item.normalized_name, 40)} ` +
      `| ${qc.order_qty ?? '—'} ${qc.order_unit || ''} ` +
      `| ${qc.invoice_qty ?? '—'} ${qc.invoice_unit || ''} ` +
      `| ${diffStr} ` +
      `| ${statusIcon} ${qc.status || ''} |`
    );
  }

  // Детали расхождений
  const withMismatches = matched.filter(m => (m.parameter_mismatches || []).length > 0);
  if (withMismatches.length > 0) {
    lines.push('');
    lines.push('### Расхождения параметров');
    lines.push('');

    for (const item of withMismatches) {
      lines.push(`**Позиция ${item.order_row} ↔ ${item.invoice_row}** (${truncate(item.normalized_name, 50)}, уверенность: ${item.match_confidence})`);
      lines.push('');
      for (const m of item.parameter_mismatches) {
        const icon = getSeverityIcon(m.severity);
        lines.push(`- ${icon} **${m.parameter}**: ${m.order_value} → ${m.invoice_value}`);
      }
      if (item.match_reasoning) {
        lines.push(`- _Пояснение: ${item.match_reasoning}_`);
      }
      lines.push('');
    }
  }

  // Пересчёт единиц
  const withConversion = matched.filter(m => {
    const qc = m.quantity_comparison || {};
    return qc.conversion_note && qc.order_unit !== qc.invoice_unit;
  });
  if (withConversion.length > 0) {
    lines.push('### Пересчёт единиц измерения');
    lines.push('');
    for (const item of withConversion) {
      const qc = item.quantity_comparison;
      lines.push(`- Позиция ${item.order_row}: ${qc.conversion_note}`);
    }
    lines.push('');
  }
}

// --- Несопоставленные позиции заказа ---
const unmatchedOrder = data.unmatched_order || [];
if (unmatchedOrder.length > 0) {
  lines.push('## Позиции заказа без пары в накладной');
  lines.push('');
  lines.push('| № | Наименование | Причина |');
  lines.push('|---|-------------|---------|');

  for (const item of unmatchedOrder) {
    lines.push(`| ${item.order_row} | ${truncate(item.order_name, 50)} | ${item.reason || '—'} |`);
  }
  lines.push('');
}

// --- Несопоставленные позиции накладной ---
const unmatchedInvoice = data.unmatched_invoice || [];
if (unmatchedInvoice.length > 0) {
  lines.push('## Позиции накладной без пары в заказе');
  lines.push('');
  lines.push('| № | Наименование | Причина |');
  lines.push('|---|-------------|---------|');

  for (const item of unmatchedInvoice) {
    lines.push(`| ${item.invoice_row} | ${truncate(item.invoice_name, 50)} | ${item.reason || '—'} |`);
  }
  lines.push('');
}

// --- Запись файла ---
const output = lines.join('\n');
fs.writeFileSync(outputPath, output, 'utf-8');
console.log(`Отчёт сохранён: ${outputPath}`);
console.log(`  Сопоставлено: ${matched.length}`);
console.log(`  Не найдено в накладной: ${unmatchedOrder.length}`);
console.log(`  Лишнее в накладной: ${unmatchedInvoice.length}`);

// --- Вспомогательные функции ---

function truncate(str, maxLen) {
  if (!str) return '—';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function getSeverityIcon(severity) {
  switch (severity) {
    case 'critical': return '\u{1F534}';
    case 'warning': return '\u{1F7E1}';
    case 'info': return '\u{2139}\u{FE0F}';
    default: return '';
  }
}

function getStatusIcon(status) {
  switch (status) {
    case 'exact': return '\u{2705}';
    case 'within_tolerance': return '\u{2705}';
    case 'over': return '\u{1F7E1}';
    case 'under': return '\u{1F7E1}';
    case 'incompatible_units': return '\u{1F534}';
    default: return '';
  }
}
