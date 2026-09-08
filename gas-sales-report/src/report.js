/**
 * gas-sales-report — 集計・整形の純関数群
 *
 * このファイルは Google Apps Script と Node.js の両方でそのまま動く。
 *   - GAS:  Code.gs から直接呼ぶ（同一プロジェクト内の関数はグローバル共有）
 *   - Node: require('./src/report.js') でテスト・ローカル実行
 * SpreadsheetApp / MailApp などの GAS サービスはここでは一切呼ばない（Code.gs 側の責務）。
 *
 * データの流れ:
 *   CSV文字列 --parseCsv--> 2次元配列 --valuesToObjects--> 行オブジェクト
 *     --normalizeRecords--> 正規化レコード --buildReport--> レポート構造
 *     --toSheetRows / formatText / formatSlack--> シート用2次元配列 / メール本文 / Slack ペイロード
 */

/** CSV の列名（既定）。列名が違う場合は normalizeRecords の第2引数で上書きする */
var DEFAULT_COLUMNS = {
  date: '日付',
  product: '商品名',
  category: 'カテゴリ',
  qty: '数量',
  unitPrice: '単価',
  staff: '担当者',
  customer: '顧客名',
};

/** レポートの既定オプション */
var DEFAULT_REPORT_OPTIONS = {
  topN: 5, // 上位 N 件
  reportTitle: '月次売上レポート',
};

// ---------------------------------------------------------------------------
// 1. CSV → 行オブジェクト
// ---------------------------------------------------------------------------

/**
 * CSV 文字列を 2 次元配列にする（RFC 4180 準拠: ダブルクォート・改行含みのセル・CRLF・BOM に対応）
 * @param {string} text
 * @return {string[][]}
 */
function parseCsv(text) {
  var src = String(text || '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // BOM 除去
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  for (var i = 0; i < src.length; i++) {
    var c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 完全な空行（区切りのみの行も含む）は捨てる
  return rows.filter(function (r) {
    return r.some(function (v) {
      return String(v).trim() !== '';
    });
  });
}

/**
 * 2 次元配列（1 行目=ヘッダー）を行オブジェクトの配列にする。
 * CSV 経由でも Sheet.getValues() 経由でも同じ形にするための共通入口。
 * @param {any[][]} values
 * @return {{header: string[], rows: Object<string, any>[]}}
 */
function valuesToObjects(values) {
  if (!values || values.length === 0) return { header: [], rows: [] };
  var header = values[0].map(function (h) {
    return String(h).trim();
  });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    var empty = true;
    for (var j = 0; j < header.length; j++) {
      var v = values[i][j];
      if (v === undefined || v === null) v = '';
      if (v !== '' && String(v).trim() !== '') empty = false;
      obj[header[j]] = v;
    }
    if (!empty) rows.push(obj);
  }
  return { header: header, rows: rows };
}

/** CSV 文字列 → 行オブジェクト配列（parseCsv + valuesToObjects） */
function csvToObjects(text) {
  return valuesToObjects(parseCsv(text));
}

// ---------------------------------------------------------------------------
// 2. 行オブジェクト → 正規化レコード
// ---------------------------------------------------------------------------

/** 2 桁ゼロ埋め */
function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/**
 * 日付らしい値を 'YYYY-MM-DD' に正規化する。解釈できなければ null。
 * 受け付ける形式: Date オブジェクト（シート由来）, 'YYYY-MM-DD', 'YYYY/M/D', 'YYYY.MM.DD', 'YYYYMMDD'
 * @param {any} value
 * @return {string|null}
 */
function normalizeDate(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return value.getFullYear() + '-' + pad2(value.getMonth() + 1) + '-' + pad2(value.getDate());
  }
  var s = String(value == null ? '' : value).trim();
  var m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/) || s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // 2/30 のような存在しない日付を弾く
  var check = new Date(y, mo - 1, d);
  if (check.getMonth() !== mo - 1 || check.getDate() !== d) return null;
  return y + '-' + pad2(mo) + '-' + pad2(d);
}

/**
 * 数値らしい値を Number にする（'1,200' '¥1,200' ' 3 ' などを許容）。解釈できなければ NaN。
 * @param {any} value
 * @return {number}
 */
function toNumber(value) {
  if (typeof value === 'number') return value;
  var s = String(value == null ? '' : value)
    .replace(/[,¥￥\s]/g, '')
    .replace(/^円|円$/g, '');
  var paren = s.match(/^\((.+)\)$/); // 会計表記の負数 (1,000) → -1000
  if (paren) s = '-' + paren[1];
  if (s === '') return NaN;
  return Number(s);
}

/**
 * 行オブジェクトを集計用レコードに正規化する。不正な行はスキップして理由を返す。
 * @param {Object<string, any>[]} rows  valuesToObjects().rows
 * @param {Object<string, string>=} columns  列名の上書き（DEFAULT_COLUMNS と同じキー）
 * @return {{records: Object[], skipped: {line: number, reason: string}[]}}
 *   records[i] = { date, month, product, category, qty, unitPrice, amount, staff, customer, raw }
 */
function normalizeRecords(rows, columns) {
  var col = {};
  var k;
  for (k in DEFAULT_COLUMNS) col[k] = DEFAULT_COLUMNS[k];
  if (columns) for (k in columns) col[k] = columns[k];

  var records = [];
  var skipped = [];
  (rows || []).forEach(function (row, idx) {
    var line = idx + 2; // ヘッダーを 1 行目とした行番号
    var date = normalizeDate(row[col.date]);
    if (!date) return skipped.push({ line: line, reason: '日付が不正: ' + row[col.date] });
    var product = String(row[col.product] == null ? '' : row[col.product]).trim();
    if (!product) return skipped.push({ line: line, reason: '商品名が空' });
    var qty = toNumber(row[col.qty]);
    var unitPrice = toNumber(row[col.unitPrice]);
    if (isNaN(qty) || isNaN(unitPrice)) {
      return skipped.push({ line: line, reason: '数量/単価が数値でない: ' + row[col.qty] + ' / ' + row[col.unitPrice] });
    }
    records.push({
      date: date,
      month: date.slice(0, 7),
      product: product,
      category: String(row[col.category] == null ? '' : row[col.category]).trim(),
      qty: qty,
      unitPrice: unitPrice,
      amount: qty * unitPrice,
      staff: String(row[col.staff] == null ? '' : row[col.staff]).trim() || '(未設定)',
      customer: String(row[col.customer] == null ? '' : row[col.customer]).trim(),
      raw: row,
    });
  });
  return { records: records, skipped: skipped };
}

// ---------------------------------------------------------------------------
// 3. 月の計算・集計ユーティリティ
// ---------------------------------------------------------------------------

/** Date → 'YYYY-MM' */
function monthKeyOf(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1);
}

/** 'YYYY-MM' の前月 → 'YYYY-MM' */
function prevMonthOf(month) {
  var parts = String(month).split('-');
  var y = Number(parts[0]);
  var m = Number(parts[1]);
  if (!y || !m) throw new Error("月の形式が不正です（'YYYY-MM' を期待）: " + month);
  return m === 1 ? y - 1 + '-12' : y + '-' + pad2(m - 1);
}

/** 'YYYY-MM' → 'YYYY年M月' */
function monthLabel(month) {
  var parts = String(month).split('-');
  return Number(parts[0]) + '年' + Number(parts[1]) + '月';
}

/**
 * 前月比（%）。前月が 0 または無い場合は null（比較不能）。小数第 1 位で丸める。
 */
function momPct(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** 合計（金額・数量・件数） */
function sumOf(records) {
  var t = { amount: 0, qty: 0, count: 0 };
  records.forEach(function (r) {
    t.amount += r.amount;
    t.qty += r.qty;
    t.count += 1;
  });
  return t;
}

/**
 * 名前をキーにする辞書。通常の {} だと 'constructor' や '__proto__' という商品名が
 * Object.prototype の継承プロパティと衝突して集計から消えるため、プロトタイプ無しで作る
 */
function nameDict() {
  return Object.create(null);
}

/**
 * key（'product' | 'staff' | 'category' など）ごとの合計を返す
 * @return {Object<string, {amount:number, qty:number, count:number}>}
 */
function groupTotals(records, key) {
  var out = nameDict();
  records.forEach(function (r) {
    var name = r[key];
    if (!out[name]) out[name] = { amount: 0, qty: 0, count: 0 };
    out[name].amount += r.amount;
    out[name].qty += r.qty;
    out[name].count += 1;
  });
  return out;
}

/**
 * 当月・前月のレコードから、金額降順のランキングを作る
 * @return {{ranking: Object[], totalNames: number, dropped: Object[]}}
 *   ranking[i] = {name, amount, qty, count, share(構成比%), prevAmount, momPct}
 *   totalNames = 当月に実績のある名前の数、dropped = 前月にあって当月ゼロの名前（前月比 -100%）
 */
function rankBy(current, previous, key, topN) {
  var cur = groupTotals(current, key);
  var prev = groupTotals(previous, key);
  var total = sumOf(current).amount;
  var list = Object.keys(cur).map(function (name) {
    var prevAmount = prev[name] ? prev[name].amount : 0;
    return {
      name: name,
      amount: cur[name].amount,
      qty: cur[name].qty,
      count: cur[name].count,
      share: total ? Math.round((cur[name].amount / total) * 1000) / 10 : 0,
      prevAmount: prevAmount,
      momPct: momPct(cur[name].amount, prevAmount),
    };
  });
  list.sort(function (a, b) {
    return b.amount - a.amount || a.name.localeCompare(b.name, 'ja');
  });
  // 前月にはあったが当月の実績がゼロの名前（離脱・販売終了の検知用）
  var dropped = Object.keys(prev)
    .filter(function (name) {
      return !cur[name];
    })
    .map(function (name) {
      return { name: name, amount: 0, qty: 0, count: 0, share: 0, prevAmount: prev[name].amount, momPct: -100 };
    })
    .sort(function (a, b) {
      return b.prevAmount - a.prevAmount || a.name.localeCompare(b.name, 'ja');
    });
  return { ranking: list.slice(0, topN), totalNames: list.length, dropped: dropped };
}

// ---------------------------------------------------------------------------
// 4. レポート構造の生成
// ---------------------------------------------------------------------------

/**
 * 正規化レコードから月次レポートを組み立てる。
 * @param {Object[]} records  normalizeRecords().records
 * @param {{targetMonth?: string, topN?: number, reportTitle?: string}=} options
 *   targetMonth 省略時はデータ中の最新月
 * @return {Object} report
 */
function buildReport(records, options) {
  var opt = {};
  var k;
  for (k in DEFAULT_REPORT_OPTIONS) opt[k] = DEFAULT_REPORT_OPTIONS[k];
  if (options) for (k in options) if (options[k] !== undefined && options[k] !== null) opt[k] = options[k];

  if (!records || records.length === 0) throw new Error('集計対象のレコードがありません');

  var months = nameDict();
  records.forEach(function (r) {
    months[r.month] = true;
  });
  var monthList = Object.keys(months).sort();
  var target = opt.targetMonth || monthList[monthList.length - 1];
  if (!months[target]) {
    throw new Error('対象月 ' + target + ' のデータがありません（存在する月: ' + monthList.join(', ') + '）');
  }
  var prev = prevMonthOf(target);

  var current = records.filter(function (r) {
    return r.month === target;
  });
  var previous = records.filter(function (r) {
    return r.month === prev;
  });
  var curTotal = sumOf(current);
  var prevTotal = sumOf(previous);

  var products = rankBy(current, previous, 'product', opt.topN);
  var staff = rankBy(current, previous, 'staff', opt.topN);

  var customers = nameDict();
  current.forEach(function (r) {
    if (r.customer) customers[r.customer] = true;
  });

  // 月次推移（データのある全月）。前月比はサマリーと同じく「暦上の前月」との比較で、
  // 前月にデータが無ければ null（比較不能）。直前のデータ月と比べてしまわないようにする
  var totalsByMonth = groupTotals(records, 'month');
  var trend = monthList.map(function (m) {
    var t = totalsByMonth[m];
    var prevOfM = totalsByMonth[prevMonthOf(m)];
    return {
      month: m,
      amount: t.amount,
      qty: t.qty,
      count: t.count,
      momPct: momPct(t.amount, prevOfM ? prevOfM.amount : 0),
    };
  });

  return {
    title: opt.reportTitle,
    targetMonth: target,
    prevMonth: prev,
    topN: opt.topN,
    totals: {
      amount: curTotal.amount,
      qty: curTotal.qty,
      count: curTotal.count,
      prevAmount: prevTotal.amount,
      prevQty: prevTotal.qty,
      prevCount: prevTotal.count,
      diff: curTotal.amount - prevTotal.amount,
      momPct: momPct(curTotal.amount, prevTotal.amount),
      qtyMomPct: momPct(curTotal.qty, prevTotal.qty),
      countMomPct: momPct(curTotal.count, prevTotal.count),
      customers: Object.keys(customers).length,
    },
    products: products.ranking,
    productCount: products.totalNames,
    productsDropped: products.dropped, // 前月に売上があり当月ゼロの商品
    staff: staff.ranking,
    staffCount: staff.totalNames,
    staffDropped: staff.dropped, // 前月に売上があり当月ゼロの担当者
    trend: trend,
  };
}

// ---------------------------------------------------------------------------
// 5. 出力整形
// ---------------------------------------------------------------------------

/** 3 桁区切り（Intl に頼らない: GAS の V8 でも同じ結果にするため） */
function fmtNumber(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  var s = String(Math.round(n));
  var sign = '';
  if (s.charAt(0) === '-') {
    sign = '-';
    s = s.slice(1);
  }
  return sign + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 金額表記 */
function fmtYen(n) {
  return '¥' + fmtNumber(n);
}

/** 前月比の表記（'+12.3%' / '-4.0%' / '-'） */
function fmtPct(p) {
  if (p === null || p === undefined || isNaN(p)) return '-';
  return (p > 0 ? '+' : '') + p.toFixed(1) + '%';
}

/**
 * 「月次レポート」シートに書き込む 2 次元配列（矩形に揃える）。
 * 金額・数量は数値のまま返す（シート側で表示形式を付ける）。
 */
function toSheetRows(report) {
  var t = report.totals;
  var rows = [];
  rows.push([report.title + ' ' + monthLabel(report.targetMonth)]);
  rows.push(['集計対象', report.targetMonth, '比較対象（前月）', report.prevMonth]);
  rows.push([]);
  rows.push(['■ サマリー']);
  rows.push(['項目', '当月', '前月', '前月比']);
  rows.push(['売上金額', t.amount, t.prevAmount, fmtPct(t.momPct)]);
  rows.push(['販売数量', t.qty, t.prevQty, fmtPct(t.qtyMomPct)]);
  rows.push(['注文件数', t.count, t.prevCount, fmtPct(t.countMomPct)]);
  rows.push(['取引顧客数', t.customers, '', '']);
  rows.push([]);
  rows.push(['■ 商品別 上位' + report.topN + '（全' + report.productCount + '商品）']);
  rows.push(['順位', '商品名', '売上金額', '数量', '構成比', '前月売上', '前月比']);
  report.products.forEach(function (p, i) {
    rows.push([i + 1, p.name, p.amount, p.qty, fmtPct(p.share).replace('+', ''), p.prevAmount, fmtPct(p.momPct)]);
  });
  report.productsDropped.forEach(function (p) {
    rows.push(['-', p.name + '（当月実績なし）', 0, 0, '0.0%', p.prevAmount, fmtPct(p.momPct)]);
  });
  rows.push([]);
  rows.push(['■ 担当者別 上位' + report.topN + '（全' + report.staffCount + '名）']);
  rows.push(['順位', '担当者', '売上金額', '数量', '構成比', '前月売上', '前月比']);
  report.staff.forEach(function (s, i) {
    rows.push([i + 1, s.name, s.amount, s.qty, fmtPct(s.share).replace('+', ''), s.prevAmount, fmtPct(s.momPct)]);
  });
  report.staffDropped.forEach(function (s) {
    rows.push(['-', s.name + '（当月実績なし）', 0, 0, '0.0%', s.prevAmount, fmtPct(s.momPct)]);
  });
  rows.push([]);
  rows.push(['■ 月次推移']);
  rows.push(['月', '売上金額', '数量', '注文件数', '前月比']);
  report.trend.forEach(function (m) {
    rows.push([m.month, m.amount, m.qty, m.count, fmtPct(m.momPct)]);
  });

  var width = rows.reduce(function (w, r) {
    return Math.max(w, r.length);
  }, 0);
  return rows.map(function (r) {
    var out = r.slice();
    while (out.length < width) out.push('');
    return out;
  });
}

/** 表示幅（全角=2, 半角=1）。ローカル表示の桁揃え用 */
function displayWidth(s) {
  var w = 0;
  var str = String(s);
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    w += c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)) ? 2 : 1;
  }
  return w;
}

function padDisplay(s, width, alignRight) {
  var str = String(s);
  var fill = Math.max(0, width - displayWidth(str));
  var sp = new Array(fill + 1).join(' ');
  return alignRight ? sp + str : str + sp;
}

/**
 * toSheetRows() の結果を等幅テキストの表にする（README・ローカル確認用）。
 * 空行で区切られたブロックごとに列幅を計算し、数値・% の列は右寄せにする。
 */
function renderTable(rows) {
  var blocks = [[]];
  rows.forEach(function (r) {
    var isEmpty = r.every(function (v) {
      return v === '' || v === null || v === undefined;
    });
    if (isEmpty) blocks.push([]);
    else blocks[blocks.length - 1].push(r);
  });

  var lines = [];
  blocks.forEach(function (block, bi) {
    if (block.length === 0) return;
    if (bi > 0) lines.push('');
    var table = [];
    block.forEach(function (r) {
      var rest = r.slice(1).every(function (v) {
        return v === '';
      });
      var isHeading = rest && (String(r[0]).charAt(0) === '■' || table.length === 0 && lines.length === 0);
      if (isHeading) lines.push(String(r[0]));
      else table.push(r);
    });
    if (table.length === 0) return;

    var cells = table.map(function (r) {
      return r.map(function (v) {
        return typeof v === 'number' ? fmtNumber(v) : String(v);
      });
    });
    var width = cells[0].length;
    // 末尾の空列を落とす
    while (width > 0 && cells.every(function (r) { return r[width - 1] === ''; })) width--;
    var colWidths = [];
    var alignRight = [];
    for (var c = 0; c < width; c++) {
      colWidths[c] = 0;
      alignRight[c] = false;
      cells.forEach(function (r, i) {
        colWidths[c] = Math.max(colWidths[c], displayWidth(r[c]));
        if (i > 0 && (typeof table[i][c] === 'number' || /%$/.test(r[c]))) alignRight[c] = true;
      });
    }
    cells.forEach(function (r) {
      var parts = [];
      for (var c = 0; c < width; c++) parts.push(padDisplay(r[c], colWidths[c], alignRight[c]));
      lines.push(parts.join('  ').replace(/\s+$/, ''));
    });
  });
  return lines.join('\n');
}

/** 「A（前月 ¥1,000）, B（前月 ¥500）」形式の 1 行 */
function droppedSummary(list) {
  return list
    .map(function (d) {
      return d.name + '（前月 ' + fmtYen(d.prevAmount) + '）';
    })
    .join(', ');
}

/**
 * メール用プレーンテキスト本文
 */
function formatText(report) {
  var t = report.totals;
  var L = [];
  L.push('【' + report.title + '】' + monthLabel(report.targetMonth));
  L.push('対象: ' + report.targetMonth + '（前月比は ' + monthLabel(report.prevMonth) + ' との比較）');
  L.push('');
  L.push('■ サマリー');
  L.push('売上金額: ' + fmtYen(t.amount) + '（前月 ' + fmtYen(t.prevAmount) + ' / ' + fmtPct(t.momPct) + '）');
  L.push('販売数量: ' + fmtNumber(t.qty) + '（前月 ' + fmtNumber(t.prevQty) + ' / ' + fmtPct(t.qtyMomPct) + '）');
  L.push('注文件数: ' + fmtNumber(t.count) + '（前月 ' + fmtNumber(t.prevCount) + ' / ' + fmtPct(t.countMomPct) + '）');
  L.push('取引顧客数: ' + fmtNumber(t.customers));
  L.push('');
  L.push('■ 商品別 上位' + report.topN);
  report.products.forEach(function (p, i) {
    L.push(i + 1 + '. ' + p.name + ' ' + fmtYen(p.amount) + '（構成比 ' + p.share.toFixed(1) + '% / 前月比 ' + fmtPct(p.momPct) + '）');
  });
  if (report.productsDropped.length) L.push('当月実績なし: ' + droppedSummary(report.productsDropped));
  L.push('');
  L.push('■ 担当者別 上位' + report.topN);
  report.staff.forEach(function (s, i) {
    L.push(i + 1 + '. ' + s.name + ' ' + fmtYen(s.amount) + '（' + fmtNumber(s.count) + '件 / 前月比 ' + fmtPct(s.momPct) + '）');
  });
  if (report.staffDropped.length) L.push('当月実績なし: ' + droppedSummary(report.staffDropped));
  L.push('');
  L.push('■ 月次推移');
  report.trend.forEach(function (m) {
    L.push(m.month + '  ' + fmtYen(m.amount) + '（' + fmtNumber(m.count) + '件 / ' + fmtPct(m.momPct) + '）');
  });
  L.push('');
  L.push('詳細はスプレッドシート「月次レポート」シートを参照してください。');
  return L.join('\n');
}

/**
 * Slack Incoming Webhook 用ペイロード（Block Kit）。
 * text はプッシュ通知・非対応クライアント向けのフォールバック。
 */
function formatSlack(report) {
  var t = report.totals;
  var arrow = t.momPct === null ? '' : t.momPct >= 0 ? ' :chart_with_upwards_trend:' : ' :chart_with_downwards_trend:';
  var productLines = report.products.map(function (p, i) {
    return i + 1 + '. ' + p.name + '  ' + fmtYen(p.amount) + '（' + fmtPct(p.momPct) + '）';
  });
  if (report.productsDropped.length) productLines.push('_当月実績なし: ' + droppedSummary(report.productsDropped) + '_');
  var staffLines = report.staff.map(function (s, i) {
    return i + 1 + '. ' + s.name + '  ' + fmtYen(s.amount) + '（' + fmtPct(s.momPct) + '）';
  });
  if (report.staffDropped.length) staffLines.push('_当月実績なし: ' + droppedSummary(report.staffDropped) + '_');
  return {
    text: report.title + ' ' + monthLabel(report.targetMonth) + ': 売上 ' + fmtYen(t.amount) + '（前月比 ' + fmtPct(t.momPct) + '）',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: report.title + ' ' + monthLabel(report.targetMonth), emoji: true } },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*売上金額 ' + fmtYen(t.amount) + '*  前月比 ' + fmtPct(t.momPct) + arrow },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*販売数量*\n' + fmtNumber(t.qty) + '（' + fmtPct(t.qtyMomPct) + '）' },
          { type: 'mrkdwn', text: '*注文件数*\n' + fmtNumber(t.count) + '（' + fmtPct(t.countMomPct) + '）' },
          { type: 'mrkdwn', text: '*前月売上*\n' + fmtYen(t.prevAmount) },
          { type: 'mrkdwn', text: '*取引顧客数*\n' + fmtNumber(t.customers) },
        ],
      },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*商品別 上位' + report.topN + '*\n' + productLines.join('\n') } },
      { type: 'section', text: { type: 'mrkdwn', text: '*担当者別 上位' + report.topN + '*\n' + staffLines.join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '対象: ' + report.targetMonth + ' ／ 詳細はスプレッドシート「月次レポート」シート' }] },
    ],
  };
}

// Node.js（テスト・ローカル実行）向けエクスポート。GAS では module が無いので何もしない。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_COLUMNS: DEFAULT_COLUMNS,
    DEFAULT_REPORT_OPTIONS: DEFAULT_REPORT_OPTIONS,
    parseCsv: parseCsv,
    valuesToObjects: valuesToObjects,
    csvToObjects: csvToObjects,
    normalizeDate: normalizeDate,
    toNumber: toNumber,
    normalizeRecords: normalizeRecords,
    monthKeyOf: monthKeyOf,
    prevMonthOf: prevMonthOf,
    monthLabel: monthLabel,
    momPct: momPct,
    sumOf: sumOf,
    nameDict: nameDict,
    groupTotals: groupTotals,
    rankBy: rankBy,
    buildReport: buildReport,
    fmtNumber: fmtNumber,
    fmtYen: fmtYen,
    fmtPct: fmtPct,
    toSheetRows: toSheetRows,
    displayWidth: displayWidth,
    renderTable: renderTable,
    droppedSummary: droppedSummary,
    formatText: formatText,
    formatSlack: formatSlack,
  };
}
