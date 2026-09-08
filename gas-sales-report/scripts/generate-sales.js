#!/usr/bin/env node
'use strict';
/**
 * sales.csv（サンプル売上データ）の生成スクリプト
 *
 * - seed 固定の疑似乱数なので、何度実行しても同じ内容になる
 * - 6 か月分・200 行。月ごとの件数の重み、担当者・商品ごとの売れ方の偏りを入れて
 *   「集計すると差が出る」現実的なデータにしている
 *
 * 使い方: node scripts/generate-sales.js  → gas-sales-report/sales.csv を上書き
 */
const fs = require('node:fs');
const path = require('node:path');

const SEED = 20260908;
const ROWS = 200;
const OUT = path.join(__dirname, '..', 'sales.csv');

// 対象月と、月ごとの注文件数の重み（繁忙・閑散を表現）
const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const MONTH_WEIGHT = [1.15, 1.0, 0.95, 1.0, 1.05, 1.2];

// 商品マスタ: w=売れやすさ・qtyMax=1注文あたりの最大数量
const PRODUCTS = [
  { name: 'コピー用紙 A4 5000枚', category: '文具', price: 3980, w: 3.0, qtyMax: 10 },
  { name: 'ボールペン 黒 10本入', category: '文具', price: 880, w: 2.5, qtyMax: 12 },
  { name: 'クリアファイル 100枚', category: '文具', price: 1500, w: 2.0, qtyMax: 6 },
  { name: '付箋 5色セット', category: '文具', price: 620, w: 2.0, qtyMax: 15 },
  { name: 'ラベルシール 30面', category: '文具', price: 980, w: 1.5, qtyMax: 8 },
  { name: 'トナーカートリッジ', category: '消耗品', price: 12800, w: 1.6, qtyMax: 3 },
  { name: 'ウェットティッシュ 業務用', category: '消耗品', price: 1280, w: 1.8, qtyMax: 10 },
  { name: 'LED デスクライト', category: '什器', price: 4500, w: 1.0, qtyMax: 4 },
  { name: 'モニターアーム', category: '什器', price: 8900, w: 0.9, qtyMax: 3 },
  { name: 'オフィスチェア', category: '什器', price: 24800, w: 0.6, qtyMax: 2 },
];

// 担当者: w=受注しやすさ
const STAFF = [
  { name: '佐藤', w: 1.4 },
  { name: '鈴木', w: 1.1 },
  { name: '高橋', w: 1.0 },
  { name: '田中', w: 0.8 },
  { name: '伊藤', w: 0.7 },
];

const CUSTOMERS = [
  { name: '株式会社アルファ商事', region: '東京' },
  { name: '合同会社ベータ', region: '東京' },
  { name: '有限会社ガンマ企画', region: '大阪' },
  { name: 'デルタ工業株式会社', region: '大阪' },
  { name: 'イプシロン株式会社', region: '名古屋' },
  { name: 'ゼータ物産', region: '福岡' },
  { name: 'エータ設計事務所', region: '東京' },
  { name: 'シータ薬局', region: '福岡' },
];

/** seed 付き疑似乱数（mulberry32） */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);

/** 重み付きで 1 件選ぶ */
function pickWeighted(items, weightOf) {
  const total = items.reduce((s, it) => s + weightOf(it), 0);
  let r = rand() * total;
  for (const it of items) {
    r -= weightOf(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

function randInt(min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}

/** 平日をランダムに 1 日選ぶ（YYYY-MM-DD） */
function pickWeekday(month) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (;;) {
    const d = randInt(1, days);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) return `${month}-${String(d).padStart(2, '0')}`;
  }
}

function csvField(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const rows = [];
for (let i = 0; i < ROWS; i++) {
  const mi = MONTHS.indexOf(pickWeighted(MONTHS, (m) => MONTH_WEIGHT[MONTHS.indexOf(m)]));
  const product = pickWeighted(PRODUCTS, (p) => p.w);
  const staff = pickWeighted(STAFF, (s) => s.w);
  const customer = CUSTOMERS[randInt(0, CUSTOMERS.length - 1)];
  rows.push({
    date: pickWeekday(MONTHS[mi]),
    product: product.name,
    category: product.category,
    qty: randInt(1, product.qtyMax),
    price: product.price,
    staff: staff.name,
    customer: customer.name,
    region: customer.region,
  });
}
rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

const header = ['日付', '注文ID', '商品名', 'カテゴリ', '数量', '単価', '担当者', '顧客名', '地域'];
const lines = [header.join(',')];
rows.forEach((r, i) => {
  const id = `SO-${String(i + 1).padStart(4, '0')}`;
  lines.push([r.date, id, r.product, r.category, r.qty, r.price, r.staff, r.customer, r.region].map(csvField).join(','));
});
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(`${OUT} に ${rows.length} 行を書き出しました`);
