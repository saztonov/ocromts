#!/usr/bin/env node
/**
 * Конвертация comparison.json в Excel-отчёт.
 * Вызов: node to-excel.js <comparison.json> [output.xlsx]
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node to-excel.js <comparison.json> [output.xlsx]');
  process.exit(1);
}

const outputPath = process.argv[3] || inputPath.replace(/\.json$/, '.xlsx').replace('comparison', 'report');
const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

// --- Лист 1: Сопоставление ---
const matchRows = [];

matchRows.push(['ОТЧЁТ О СВЕРКЕ ЗАКАЗА И НАКЛАДНОЙ']);
matchRows.push([`Заказ: ${data.metadata?.order_file || ''}`]);
matchRows.push([`Накладная: ${data.metadata?.invoice_file || ''}`]);
matchRows.push([`Дата сверки: ${data.metadata?.comparison_date || ''}`]);
matchRows.push([]);
matchRows.push([
  '№ заказа',
  '№ накладной',
  'Нормализованное наименование',
  'Кол-во заказ',
  'Ед. заказ',
  'Кол-во накл.',
  'Ед. накл.',
  'Разница %',
  'Статус кол-ва',
  'Уверенность',
  'Расхождения',
]);

for (const item of (data.matched_items || [])) {
  const qc = item.quantity_comparison || {};
  const mismatches = (item.parameter_mismatches || [])
    .map(m => `[${m.severity}] ${m.parameter}: ${m.order_value} → ${m.invoice_value}`)
    .join('; ');

  matchRows.push([
    item.order_row,
    item.invoice_row,
    item.normalized_name || '',
    qc.order_qty != null ? qc.order_qty : '',
    qc.order_unit || '',
    qc.invoice_qty != null ? qc.invoice_qty : '',
    qc.invoice_unit || '',
    qc.difference_pct != null ? qc.difference_pct : '',
    qc.status || '',
    item.match_confidence != null ? item.match_confidence : '',
    mismatches,
  ]);
}

// --- Лист 2: Несопоставленные ---
const unmatchRows = [];

unmatchRows.push(['НЕСОПОСТАВЛЕННЫЕ ПОЗИЦИИ']);
unmatchRows.push([]);
unmatchRows.push(['--- Позиции заказа без пары ---']);
unmatchRows.push(['№ позиции', 'Наименование', 'Причина']);

for (const item of (data.unmatched_order || [])) {
  unmatchRows.push([
    item.order_row,
    item.order_name || '',
    item.reason || '',
  ]);
}

unmatchRows.push([]);
unmatchRows.push(['--- Позиции накладной без пары ---']);
unmatchRows.push(['№ позиции', 'Наименование', 'Причина']);

for (const item of (data.unmatched_invoice || [])) {
  unmatchRows.push([
    item.invoice_row,
    item.invoice_name || '',
    item.reason || '',
  ]);
}

// --- Лист 3: Сводка ---
const summaryRows = [];
const s = data.summary || {};

summaryRows.push(['СВОДКА СВЕРКИ']);
summaryRows.push([]);
summaryRows.push(['Показатель', 'Значение']);
summaryRows.push(['Всего позиций заказа', s.total_order || 0]);
summaryRows.push(['Всего позиций накладной', s.total_invoice || 0]);
summaryRows.push(['Сопоставлено', s.matched || 0]);
summaryRows.push(['Не найдено в накладной', s.unmatched_order || 0]);
summaryRows.push(['Лишнее в накладной', s.unmatched_invoice || 0]);
summaryRows.push(['Критичных расхождений', s.critical_mismatches || 0]);
summaryRows.push(['Предупреждений', s.warnings || 0]);
summaryRows.push([]);
summaryRows.push(['Файл заказа', data.metadata?.order_file || '']);
summaryRows.push(['Файл накладной', data.metadata?.invoice_file || '']);
summaryRows.push(['Дата сверки', data.metadata?.comparison_date || '']);

// --- Сборка книги ---
const wb = XLSX.utils.book_new();

const ws1 = XLSX.utils.aoa_to_sheet(matchRows);
ws1['!cols'] = [
  { wch: 10 },  // № заказа
  { wch: 10 },  // № накладной
  { wch: 50 },  // Наименование
  { wch: 12 },  // Кол-во заказ
  { wch: 8 },   // Ед. заказ
  { wch: 12 },  // Кол-во накл.
  { wch: 8 },   // Ед. накл.
  { wch: 10 },  // Разница %
  { wch: 16 },  // Статус
  { wch: 12 },  // Уверенность
  { wch: 60 },  // Расхождения
];
XLSX.utils.book_append_sheet(wb, ws1, 'Сопоставление');

const ws2 = XLSX.utils.aoa_to_sheet(unmatchRows);
ws2['!cols'] = [
  { wch: 10 },
  { wch: 60 },
  { wch: 40 },
];
XLSX.utils.book_append_sheet(wb, ws2, 'Несопоставленные');

const ws3 = XLSX.utils.aoa_to_sheet(summaryRows);
ws3['!cols'] = [
  { wch: 30 },
  { wch: 20 },
];
XLSX.utils.book_append_sheet(wb, ws3, 'Сводка');

XLSX.writeFile(wb, outputPath);
console.log(`Отчёт сохранён: ${outputPath}`);
console.log(`  Сопоставлено: ${(data.matched_items || []).length}`);
console.log(`  Не найдено в накладной: ${(data.unmatched_order || []).length}`);
console.log(`  Лишнее в накладной: ${(data.unmatched_invoice || []).length}`);
