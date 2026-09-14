'use strict';
/**
 * Code.gs（GAS ラッパ）のスモークテスト
 *   GAS のサービス（SpreadsheetApp など）を最小のスタブに置き換え、src/report.js と Code.gs を
 *   同一グローバルで評価して「貼り付けたときに動くか」を確認する。
 *   実行: node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const REPORT_SRC = fs.readFileSync(path.join(ROOT, 'src', 'report.js'), 'utf8');
const CODE_SRC = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
const SALES_CSV = fs.readFileSync(path.join(ROOT, 'sales.csv'), 'utf8');

/** チェーン可能なレンジのスタブ */
function makeRange(calls) {
  const range = {};
  ['setValues', 'setNumberFormat', 'setNumberFormats', 'setFontSize', 'setFontWeight', 'setBackground', 'setBorder'].forEach((m) => {
    range[m] = (...args) => {
      calls.push([m, ...args]);
      return range;
    };
  });
  return range;
}

/** シートのスタブ（getValues で返す値と、書き込みの記録） */
function makeSheet(name, values) {
  const calls = [];
  return {
    name,
    calls,
    getDataRange: () => ({ getValues: () => values }),
    clear: () => calls.push(['clear']),
    getRange: (r, c, nr, nc) => {
      calls.push(['getRange', r, c, nr, nc]);
      return makeRange(calls);
    },
    setFrozenRows: (n) => calls.push(['setFrozenRows', n]),
    autoResizeColumns: (c, n) => calls.push(['autoResizeColumns', c, n]),
    getColumnWidth: () => 100,
    setColumnWidth: (c, w) => calls.push(['setColumnWidth', c, w]),
  };
}

/**
 * GAS 環境を模した VM を作る
 * @param {{props?: Object, sheets?: Object, files?: {name, updated, text}[], slackStatus?: number}} opt
 */
function makeGas(opt = {}) {
  const state = { mails: [], fetches: [], triggers: [], logs: [], sheets: { ...(opt.sheets || {}) } };
  const props = opt.props || {};
  const files = (opt.files || []).map((f) => ({
    getName: () => f.name,
    getLastUpdated: () => f.updated,
    getBlob: () => ({ getDataAsString: (charset) => (state.charset = charset, f.text) }),
  }));
  const sandbox = {
    Logger: { log: (...a) => state.logs.push(a.join(' ')) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => state.sheets[n] || null,
        insertSheet: (n) => (state.sheets[n] = makeSheet(n, [])),
      }),
    },
    DriveApp: {
      getFolderById: (id) => {
        state.folderId = id;
        let i = 0;
        return { getFiles: () => ({ hasNext: () => i < files.length, next: () => files[i++] }) };
      },
    },
    MailApp: { sendEmail: (m) => state.mails.push(m) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
    UrlFetchApp: {
      fetch: (url, o) => {
        state.fetches.push({ url, options: o });
        return { getResponseCode: () => opt.slackStatus || 200, getContentText: () => 'ok' };
      },
    },
    ScriptApp: {
      newTrigger: (fn) => {
        const t = { fn, getHandlerFunction: () => fn };
        const b = {
          timeBased: () => b,
          onMonthDay: (d) => ((t.day = d), b),
          atHour: (h) => ((t.hour = h), b),
          create: () => (state.triggers.push(t), t),
        };
        return b;
      },
      getProjectTriggers: () => state.triggers.slice(),
      deleteTrigger: (t) => (state.triggers = state.triggers.filter((x) => x !== t)),
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(REPORT_SRC, ctx, { filename: 'report.js' });
  vm.runInContext(CODE_SRC, ctx, { filename: 'Code.gs' });
  return { ctx, state, call: (fn) => vm.runInContext(`${fn}()`, ctx) };
}

/** sales.csv を Sheet.getValues() が返す形（日付は Date・数値は number）にする。Date は VM 側の realm で作る */
function csvAsSheetValues(ctx) {
  const CtxDate = vm.runInContext('Date', ctx);
  const rows = vm.runInContext('parseCsv', ctx)(SALES_CSV);
  return rows.map((r, i) => {
    if (i === 0) return r;
    const [y, m, d] = r[0].split('-').map(Number);
    return [new CtxDate(y, m - 1, d), r[1], r[2], r[3], Number(r[4]), Number(r[5]), r[6], r[7], r[8]];
  });
}

test('previewReport: 「売上データ」シートから集計し、レポートシートを作って書き込む（通知なし）', () => {
  const gas = makeGas();
  gas.state.sheets['売上データ'] = makeSheet('売上データ', csvAsSheetValues(gas.ctx));
  gas.call('previewReport');

  const report = gas.state.sheets['月次レポート'];
  assert.ok(report, 'レポートシートが作成される');
  const setValues = report.calls.find((c) => c[0] === 'setValues');
  const rows = setValues[1];
  assert.equal(rows[0][0], '月次売上レポート 2026年8月');
  assert.ok(rows.every((r) => r.length === rows[0].length), '矩形');
  // 文字列セル（"2026-08"・"+4.2%"）の自動変換を防ぐため、setValues より前に '@' 書式を敷く
  const fmtIdx = report.calls.findIndex((c) => c[0] === 'setNumberFormats');
  const valIdx = report.calls.findIndex((c) => c[0] === 'setValues');
  assert.ok(fmtIdx >= 0 && fmtIdx < valIdx, 'setNumberFormats が setValues より先');
  const formats = report.calls[fmtIdx][1];
  assert.equal(formats.length, rows.length);
  rows.forEach((r, i) => r.forEach((v, j) => {
    assert.equal(formats[i][j], typeof v === 'number' ? '#,##0' : '@', `[${i}][${j}] ${JSON.stringify(v)}`);
  }));
  assert.equal(formats[1][1], '@', '集計対象の月 "2026-08" は文字列書式');
  // 全角の商品名が切れないよう、表示幅から列幅を下支えする（列 2 = 商品名/担当者）
  const widths = report.calls.filter((c) => c[0] === 'setColumnWidth');
  assert.equal(widths.length, rows[0].length, '全列に setColumnWidth');
  const nameCol = widths.find((c) => c[1] === 2);
  assert.ok(nameCol[2] >= 14 + 20 * 7, `商品名列は "コピー用紙 A4 5000枚"（表示幅 20）が収まる幅: ${nameCol[2]}`);
  assert.deepEqual(report.calls[0], ['clear']);
  assert.ok(report.calls.some((c) => c[0] === 'setFrozenRows'));
  assert.equal(gas.state.mails.length, 0);
  assert.equal(gas.state.fetches.length, 0);
  assert.ok(gas.state.logs.some((l) => l.includes('プレビュー')));
});

test('previewReport: 売上データが無くプロパティも無ければ分かるエラー', () => {
  const gas = makeGas();
  assert.throws(() => gas.call('previewReport'), /売上データ/);
});

test('runReportFor: Drive の最新 CSV を読み、メールと Slack に通知する', () => {
  const gas = makeGas({
    props: { CSV_FOLDER_ID: 'folder-1', MAIL_TO: 'a@example.com,b@example.com', SLACK_WEBHOOK_URL: 'https://hooks.example/xxx' },
    files: [
      { name: 'old.csv', updated: new Date('2026-07-01'), text: '日付,商品名,数量,単価\n2026-06-01,古い,1,1\n' },
      { name: 'notes.txt', updated: new Date('2026-09-05'), text: 'ignore' },
      { name: 'sales-2026-08.csv', updated: new Date('2026-09-01'), text: SALES_CSV },
    ],
  });
  gas.call('runReportFor'); // REPORT_CONFIG.manualTargetMonth = '2026-08'

  assert.equal(gas.state.folderId, 'folder-1');
  assert.equal(gas.state.charset, 'UTF-8');
  assert.ok(gas.state.logs.some((l) => l.includes('sales-2026-08.csv')), '最新の CSV が選ばれる');

  assert.equal(gas.state.mails.length, 1);
  assert.equal(gas.state.mails[0].to, 'a@example.com,b@example.com');
  assert.equal(gas.state.mails[0].subject, '[月次売上レポート] 2026年8月');
  assert.match(gas.state.mails[0].body, /^【月次売上レポート】2026年8月/);

  assert.equal(gas.state.fetches.length, 1);
  const f = gas.state.fetches[0];
  assert.equal(f.url, 'https://hooks.example/xxx');
  assert.equal(f.options.method, 'post');
  assert.equal(f.options.contentType, 'application/json');
  const payload = JSON.parse(f.options.payload);
  assert.equal(payload.blocks[0].type, 'header');
  assert.match(payload.text, /2026年8月/);
});

test('runReportFor: MAIL_TO 未設定ならトリガー所有者宛・Slack 未設定ならスキップ', () => {
  const gas = makeGas({ props: { CSV_FOLDER_ID: 'f' }, files: [{ name: 's.csv', updated: new Date(), text: SALES_CSV }] });
  gas.call('runReportFor');
  assert.equal(gas.state.mails[0].to, 'me@example.com');
  assert.equal(gas.state.fetches.length, 0);
  assert.ok(gas.state.logs.some((l) => l.includes('SLACK_WEBHOOK_URL')));
});

test('postSlack_: Webhook が 200 以外ならエラーにする', () => {
  const gas = makeGas({
    props: { CSV_FOLDER_ID: 'f', SLACK_WEBHOOK_URL: 'https://hooks.example/bad' },
    files: [{ name: 's.csv', updated: new Date(), text: SALES_CSV }],
    slackStatus: 404,
  });
  assert.throws(() => gas.call('runReportFor'), /Slack 通知に失敗: HTTP 404/);
});

test('setupMonthlyTrigger: 毎月1日 9 時のトリガーを 1 本だけ持つ（再実行しても増えない）', () => {
  const gas = makeGas();
  gas.call('setupMonthlyTrigger');
  gas.call('setupMonthlyTrigger');
  assert.equal(gas.state.triggers.length, 1);
  const t = gas.state.triggers[0];
  assert.deepEqual([t.fn, t.day, t.hour], ['runMonthlyReport', 1, 9]);
  gas.call('deleteMonthlyTrigger');
  assert.equal(gas.state.triggers.length, 0);
});
