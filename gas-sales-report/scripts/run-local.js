#!/usr/bin/env node
'use strict';
/**
 * ローカル実行（Google アカウント不要）
 *   sales.csv を読み込んで、GAS が出力するのと同じ「月次レポート」表・メール本文・Slack ペイロードを標準出力に出す。
 *
 * 使い方:
 *   node scripts/run-local.js                       # 最新月・上位5・すべて表示
 *   node scripts/run-local.js --month 2026-07       # 対象月を指定
 *   node scripts/run-local.js --top 3 --only mail   # 上位3・メール本文だけ（only: sheet | mail | slack）
 *   node scripts/run-local.js --csv path/to/other.csv
 */
const fs = require('node:fs');
const path = require('node:path');
const R = require('../src/report.js');

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const csvPath = path.resolve(opt('csv', path.join(__dirname, '..', 'sales.csv')));
const only = opt('only', 'all');
const text = fs.readFileSync(csvPath, 'utf8');
const { records, skipped } = R.normalizeRecords(R.csvToObjects(text).rows);
const report = R.buildReport(records, { targetMonth: opt('month', null), topN: Number(opt('top', 5)) });

const out = [];
out.push(`# 入力: ${path.relative(process.cwd(), csvPath)}（${records.length} 行を集計・${skipped.length} 行スキップ）`);
skipped.forEach((s) => out.push(`#   行${s.line}: ${s.reason}`));
if (only === 'all' || only === 'sheet') {
  out.push('', '===== 「月次レポート」シート（setValues される内容） =====', '');
  out.push(R.renderTable(R.toSheetRows(report)));
}
if (only === 'all' || only === 'mail') {
  out.push('', '===== メール本文（プレーンテキスト） =====', '');
  out.push(R.formatText(report));
}
if (only === 'all' || only === 'slack') {
  out.push('', '===== Slack Incoming Webhook ペイロード（JSON） =====', '');
  out.push(JSON.stringify(R.formatSlack(report), null, 2));
}
console.log(out.join('\n'));
