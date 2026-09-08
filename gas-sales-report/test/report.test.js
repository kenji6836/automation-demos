'use strict';
/**
 * 集計ロジック（src/report.js）のテスト — Node 標準の node:test のみ使用（追加依存なし）
 *   実行: node --test   （gas-sales-report/ 直下で）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../src/report.js');

// --- テスト用の小さなデータセット（3 か月・2 商品・2 担当） ---
const FIXTURE_CSV = [
  '日付,注文ID,商品名,カテゴリ,数量,単価,担当者,顧客名',
  '2026-06-10,SO-1,商品A,文具,2,1000,佐藤,顧客X',
  '2026-07-01,SO-2,商品A,文具,3,1000,佐藤,顧客X',
  '2026-07-15,SO-3,商品B,什器,1,5000,鈴木,顧客Y',
  '2026-08-02,SO-4,商品A,文具,4,1000,佐藤,顧客X',
  '2026-08-03,SO-5,商品B,什器,2,5000,鈴木,顧客Y',
  '2026-08-20,SO-6,商品A,文具,1,1000,鈴木,顧客Z',
].join('\n');

function fixtureRecords() {
  return R.normalizeRecords(R.csvToObjects(FIXTURE_CSV).rows).records;
}

// ---------------------------------------------------------------- parseCsv
test('parseCsv: 基本・CRLF・BOM・空行を扱える', () => {
  const rows = R.parseCsv('\uFEFFa,b,c\r\n1,2,3\r\n\r\n4,5,6\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
    ['4', '5', '6'],
  ]);
});

test('parseCsv: ダブルクォート内のカンマ・改行・エスケープされた引用符', () => {
  const rows = R.parseCsv('name,memo\n"株式会社A, B","1行目\n2行目"\n"He said ""hi""",x');
  assert.deepEqual(rows, [
    ['name', 'memo'],
    ['株式会社A, B', '1行目\n2行目'],
    ['He said "hi"', 'x'],
  ]);
});

test('parseCsv: 空文字列は空配列', () => {
  assert.deepEqual(R.parseCsv(''), []);
});

// ---------------------------------------------------------- valuesToObjects
test('valuesToObjects: ヘッダー行をキーにし、空行は除く（シート getValues 相当）', () => {
  const r = R.valuesToObjects([
    [' 日付 ', '数量'],
    ['2026-08-01', 3],
    ['', ''],
    [null, undefined],
  ]);
  assert.deepEqual(r.header, ['日付', '数量']);
  assert.deepEqual(r.rows, [{ 日付: '2026-08-01', 数量: 3 }]);
});

// ------------------------------------------------------------ normalizeDate
test('normalizeDate: 各種形式を YYYY-MM-DD に揃える', () => {
  assert.equal(R.normalizeDate('2026-08-01'), '2026-08-01');
  assert.equal(R.normalizeDate('2026/8/1'), '2026-08-01');
  assert.equal(R.normalizeDate('2026.08.01'), '2026-08-01');
  assert.equal(R.normalizeDate('20260801'), '2026-08-01');
  assert.equal(R.normalizeDate('2026/08/01 13:00'), '2026-08-01');
  assert.equal(R.normalizeDate(new Date(2026, 7, 1)), '2026-08-01');
});

test('normalizeDate: 不正な日付は null', () => {
  assert.equal(R.normalizeDate('2026-02-30'), null);
  assert.equal(R.normalizeDate('8/1'), null);
  assert.equal(R.normalizeDate(''), null);
  assert.equal(R.normalizeDate(new Date('x')), null);
});

// ----------------------------------------------------------------- toNumber
test('toNumber: カンマ・円記号・空白付きの数値を読む', () => {
  assert.equal(R.toNumber('1,200'), 1200);
  assert.equal(R.toNumber('¥3,980'), 3980);
  assert.equal(R.toNumber(' 3 '), 3);
  assert.equal(R.toNumber(12), 12);
  assert.equal(R.toNumber('(1,000)'), -1000, '会計表記の負数');
  assert.equal(R.toNumber('-2'), -2);
  assert.ok(Number.isNaN(R.toNumber('abc')));
  assert.ok(Number.isNaN(R.toNumber('')));
});

// --------------------------------------------------------- normalizeRecords
test('normalizeRecords: 金額=数量×単価・月キー・担当者の既定値', () => {
  const { records, skipped } = R.normalizeRecords([
    { 日付: '2026/8/5', 商品名: 'A', 数量: '2', 単価: '1,500', 担当者: '', 顧客名: 'X' },
  ]);
  assert.equal(skipped.length, 0);
  assert.equal(records[0].amount, 3000);
  assert.equal(records[0].month, '2026-08');
  assert.equal(records[0].staff, '(未設定)');
});

test('normalizeRecords: 不正な行はスキップして行番号と理由を返す', () => {
  const { records, skipped } = R.normalizeRecords([
    { 日付: 'なし', 商品名: 'A', 数量: 1, 単価: 1 },
    { 日付: '2026-08-01', 商品名: '', 数量: 1, 単価: 1 },
    { 日付: '2026-08-01', 商品名: 'A', 数量: 'x', 単価: 1 },
    { 日付: '2026-08-01', 商品名: 'A', 数量: 1, 単価: 100 },
  ]);
  assert.equal(records.length, 1);
  assert.deepEqual(
    skipped.map((s) => s.line),
    [2, 3, 4]
  );
  assert.match(skipped[0].reason, /日付/);
  assert.match(skipped[1].reason, /商品名/);
  assert.match(skipped[2].reason, /数量\/単価/);
});

test('normalizeRecords: 列名の上書き（英語ヘッダーの CSV）', () => {
  const { records } = R.normalizeRecords([{ date: '2026-08-01', item: 'A', q: 2, price: 10, rep: 'S', client: 'C' }], {
    date: 'date',
    product: 'item',
    qty: 'q',
    unitPrice: 'price',
    staff: 'rep',
    customer: 'client',
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].amount, 20);
  assert.equal(records[0].staff, 'S');
});

// ---------------------------------------------------------- 月ユーティリティ
test('prevMonthOf / monthKeyOf / monthLabel', () => {
  assert.equal(R.prevMonthOf('2026-08'), '2026-07');
  assert.equal(R.prevMonthOf('2026-01'), '2025-12');
  assert.equal(R.monthKeyOf(new Date(2026, 0, 31)), '2026-01');
  assert.equal(R.monthLabel('2026-08'), '2026年8月');
  assert.throws(() => R.prevMonthOf('bad'));
});

test('momPct: 前月 0 は null・小数第1位で丸め', () => {
  assert.equal(R.momPct(110, 100), 10);
  assert.equal(R.momPct(90, 100), -10);
  assert.equal(R.momPct(100, 0), null);
  assert.equal(R.momPct(1, 3), -66.7);
});

// -------------------------------------------------------------- buildReport
test('buildReport: 既定は最新月・前月比・上位N・構成比', () => {
  const report = R.buildReport(fixtureRecords());
  assert.equal(report.targetMonth, '2026-08');
  assert.equal(report.prevMonth, '2026-07');
  // 8月: A=4000+1000, B=10000 → 15000 / 7月: 3000+5000 = 8000
  assert.equal(report.totals.amount, 15000);
  assert.equal(report.totals.prevAmount, 8000);
  assert.equal(report.totals.momPct, 87.5);
  assert.equal(report.totals.count, 3);
  assert.equal(report.totals.customers, 3);
  // 商品ランキングは金額降順
  assert.deepEqual(
    report.products.map((p) => p.name),
    ['商品B', '商品A']
  );
  assert.equal(report.products[0].share, 66.7);
  assert.equal(report.products[0].prevAmount, 5000);
  assert.equal(report.products[0].momPct, 100);
  // 担当者: 鈴木 = 10000+1000, 佐藤 = 4000
  assert.deepEqual(
    report.staff.map((s) => [s.name, s.amount]),
    [
      ['鈴木', 11000],
      ['佐藤', 4000],
    ]
  );
  // 推移は全期間・最初の月の前月比は null
  assert.deepEqual(
    report.trend.map((m) => [m.month, m.amount, m.momPct]),
    [
      ['2026-06', 2000, null],
      ['2026-07', 8000, 300],
      ['2026-08', 15000, 87.5],
    ]
  );
});

test('buildReport: 同額は名前順で安定ソート', () => {
  const { records } = R.normalizeRecords([
    { 日付: '2026-08-01', 商品名: 'B', 数量: 1, 単価: 100, 担当者: 'x' },
    { 日付: '2026-08-01', 商品名: 'A', 数量: 1, 単価: 100, 担当者: 'y' },
    { 日付: '2026-08-01', 商品名: 'C', 数量: 2, 単価: 100, 担当者: 'x' },
  ]);
  const report = R.buildReport(records);
  assert.deepEqual(
    report.products.map((p) => p.name),
    ['C', 'A', 'B']
  );
});

test('buildReport: 前月にあって当月ゼロの商品・担当者は dropped に前月比 -100% で出る', () => {
  const report = R.buildReport(fixtureRecords(), { targetMonth: '2026-07' });
  // 6月は商品A/佐藤のみ → 7月は両方あるので dropped なし
  assert.deepEqual(report.productsDropped, []);
  const { records } = R.normalizeRecords([
    { 日付: '2026-07-01', 商品名: '廃番品', 数量: 1, 単価: 500, 担当者: '退職者' },
    { 日付: '2026-08-01', 商品名: '現行品', 数量: 1, 単価: 800, 担当者: '在籍者' },
  ]);
  const r2 = R.buildReport(records);
  assert.deepEqual(r2.productsDropped, [{ name: '廃番品', amount: 0, qty: 0, count: 0, share: 0, prevAmount: 500, momPct: -100 }]);
  assert.equal(r2.staffDropped[0].name, '退職者');
  assert.equal(r2.productCount, 1, '当月に実績のある商品数には含めない');
  const text = R.formatText(r2);
  assert.match(text, /^当月実績なし: 廃番品（前月 ¥500）$/m);
  const rows = R.toSheetRows(r2);
  assert.ok(rows.some((row) => row[0] === '-' && row[1] === '廃番品（当月実績なし）' && row[6] === '-100.0%'));
  assert.match(JSON.stringify(R.formatSlack(r2)), /当月実績なし: 退職者/);
});

test('buildReport: 月次推移の前月比は暦上の前月と比較し、前月にデータが無ければ null', () => {
  const { records } = R.normalizeRecords([
    { 日付: '2026-06-01', 商品名: 'A', 数量: 1, 単価: 100, 担当者: 'x' },
    { 日付: '2026-08-01', 商品名: 'A', 数量: 1, 単価: 200, 担当者: 'x' },
    { 日付: '2026-09-01', 商品名: 'A', 数量: 1, 単価: 300, 担当者: 'x' },
  ]);
  const report = R.buildReport(records);
  assert.deepEqual(
    report.trend.map((m) => [m.month, m.amount, m.momPct]),
    [
      ['2026-06', 100, null],
      ['2026-08', 200, null], // 7月のデータが無いので 6月(+100%)とは比べない
      ['2026-09', 300, 50],
    ]
  );
  // サマリー側と同じ判定になっている
  const aug = R.buildReport(records, { targetMonth: '2026-08' });
  assert.equal(aug.totals.momPct, null);
  assert.equal(aug.trend[1].momPct, aug.totals.momPct);
});

test('buildReport: 商品名・担当者・顧客名が constructor / __proto__ / toString でも正しく集計される', () => {
  const names = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
  const rows = names.map((n, i) => ({ 日付: '2026-08-0' + (i + 1), 商品名: n, 数量: 1, 単価: 100 * (i + 1), 担当者: n, 顧客名: n }));
  rows.push({ 日付: '2026-08-05', 商品名: '普通の商品', 数量: 1, 単価: 50, 担当者: '普通の人', 顧客名: '普通の客' });
  rows.push({ 日付: '2026-07-01', 商品名: 'constructor', 数量: 1, 単価: 80, 担当者: 'valueOf', 顧客名: 'x' });
  const { records, skipped } = R.normalizeRecords(rows);
  assert.equal(skipped.length, 0);
  const report = R.buildReport(records, { topN: 10 });
  assert.equal(report.totals.amount, 100 + 200 + 300 + 400 + 50);
  assert.equal(report.totals.customers, 5);
  assert.deepEqual(
    report.products.map((p) => [p.name, p.amount]),
    [
      ['hasOwnProperty', 400],
      ['toString', 300],
      ['__proto__', 200],
      ['constructor', 100],
      ['普通の商品', 50],
    ]
  );
  assert.equal(report.productCount, 5);
  const ctor = report.products.find((p) => p.name === 'constructor');
  assert.equal(ctor.prevAmount, 80);
  assert.equal(ctor.momPct, 25);
  // 前月のみの担当者 'valueOf' は dropped に出る
  assert.deepEqual(
    report.staffDropped.map((s) => s.name),
    ['valueOf']
  );
  const g = R.groupTotals(records, 'product'); // 全期間: constructor は 8月100 + 7月80
  assert.equal(Object.getPrototypeOf(g), null);
  assert.equal(g.constructor.amount, 180);
  assert.equal(g.__proto__.amount, 200);
  assert.equal(typeof g.toString, 'object', '継承メソッドではなく集計値');
});

test('buildReport: topN で件数を絞る・全件数は別途返す', () => {
  const report = R.buildReport(fixtureRecords(), { topN: 1 });
  assert.equal(report.products.length, 1);
  assert.equal(report.productCount, 2);
  assert.equal(report.staff.length, 1);
  assert.equal(report.staffCount, 2);
});

test('buildReport: 対象月を指定できる・前月データが無ければ前月比は null', () => {
  const report = R.buildReport(fixtureRecords(), { targetMonth: '2026-06' });
  assert.equal(report.totals.amount, 2000);
  assert.equal(report.totals.prevAmount, 0);
  assert.equal(report.totals.momPct, null);
});

test('buildReport: 存在しない月・空データはエラー', () => {
  assert.throws(() => R.buildReport(fixtureRecords(), { targetMonth: '2026-09' }), /2026-09/);
  assert.throws(() => R.buildReport([]), /レコードがありません/);
});

// --------------------------------------------------------------- 出力整形
test('fmtNumber / fmtYen / fmtPct', () => {
  assert.equal(R.fmtNumber(1234567), '1,234,567');
  assert.equal(R.fmtNumber(-1000), '-1,000');
  assert.equal(R.fmtYen(0), '¥0');
  assert.equal(R.fmtPct(12.34), '+12.3%');
  assert.equal(R.fmtPct(-5), '-5.0%');
  assert.equal(R.fmtPct(null), '-');
});

test('toSheetRows: 矩形（全行同じ列数）で、見出し・数値がそのまま入る', () => {
  const rows = R.toSheetRows(R.buildReport(fixtureRecords()));
  const width = rows[0].length;
  assert.ok(rows.every((r) => r.length === width), '全行が同じ列数');
  assert.equal(rows[0][0], '月次売上レポート 2026年8月');
  const summary = rows.find((r) => r[0] === '売上金額');
  assert.deepEqual(summary.slice(0, 4), ['売上金額', 15000, 8000, '+87.5%']);
  assert.ok(rows.some((r) => String(r[0]).startsWith('■ 商品別')));
  assert.ok(rows.some((r) => r[0] === '2026-06'), '月次推移に全期間が入る');
});

test('renderTable: 数値は3桁区切り・右寄せ、見出し行はそのまま', () => {
  const text = R.renderTable(R.toSheetRows(R.buildReport(fixtureRecords())));
  assert.match(text, /^月次売上レポート 2026年8月$/m);
  assert.match(text, /^■ サマリー$/m);
  assert.match(text, /売上金額\s+15,000\s+8,000\s+\+87\.5%$/m);
  assert.ok(!/\s$/m.test(text.split('\n').join('|')), '行末に余分な空白がない');
});

test('formatText: メール本文に主要な行が含まれる', () => {
  const text = R.formatText(R.buildReport(fixtureRecords()));
  assert.match(text, /^【月次売上レポート】2026年8月$/m);
  assert.match(text, /^売上金額: ¥15,000（前月 ¥8,000 \/ \+87\.5%）$/m);
  assert.match(text, /^1\. 商品B ¥10,000（構成比 66\.7% \/ 前月比 \+100\.0%）$/m);
  assert.match(text, /^1\. 鈴木 ¥11,000（2件 \/ 前月比 \+120\.0%）$/m);
  assert.match(text, /^2026-07  ¥8,000（2件 \/ \+300\.0%）$/m);
});

test('formatSlack: フォールバック text と Block Kit の blocks を持ち JSON 化できる', () => {
  const payload = R.formatSlack(R.buildReport(fixtureRecords()));
  assert.match(payload.text, /売上 ¥15,000（前月比 \+87\.5%）/);
  assert.equal(payload.blocks[0].type, 'header');
  assert.ok(payload.blocks.some((b) => b.type === 'section' && Array.isArray(b.fields) && b.fields.length === 4));
  const json = JSON.stringify(payload);
  assert.ok(json.length < 4000, 'Slack の 1 メッセージ上限に十分収まる');
  assert.deepEqual(JSON.parse(json), payload);
});

// ---------------------------------------------------- 同梱 sales.csv の統合
test('同梱の sales.csv: 200 行がすべて取り込め、集計の整合が取れる', () => {
  const csv = fs.readFileSync(path.join(__dirname, '..', 'sales.csv'), 'utf8');
  const { records, skipped } = R.normalizeRecords(R.csvToObjects(csv).rows);
  assert.equal(records.length, 200);
  assert.equal(skipped.length, 0);
  const report = R.buildReport(records, { topN: 5 });
  // 推移の合計 = 全レコードの合計
  const trendSum = report.trend.reduce((s, m) => s + m.amount, 0);
  const allSum = records.reduce((s, r) => s + r.amount, 0);
  assert.equal(trendSum, allSum);
  // 当月の商品ランキング上位の構成比合計は 100% を超えない・降順
  const shares = report.products.map((p) => p.share);
  assert.ok(shares.reduce((a, b) => a + b, 0) <= 100.05);
  assert.ok(shares.every((s, i) => i === 0 || s <= shares[i - 1]));
  // 担当者は 5 名すべて含まれる
  assert.equal(report.staffCount, 5);
});
