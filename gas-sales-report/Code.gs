/**
 * gas-sales-report — Google Apps Script 側（薄いラッパ）
 *
 * 集計・整形のロジックはすべて src/report.js（純関数）にあり、このファイルは
 * SpreadsheetApp / DriveApp / MailApp / UrlFetchApp / ScriptApp の呼び出しだけを担当する。
 *
 * ▼ 使い方（詳細は README）
 *   1. スクリプト プロパティを設定（プロジェクトの設定 → スクリプト プロパティ）
 *        CSV_FOLDER_ID      売上 CSV を置く Google ドライブのフォルダ ID
 *                           （未設定の場合は、このスプレッドシートの「売上データ」シートを読む）
 *        MAIL_TO            通知メールの宛先（カンマ区切りで複数可・トリガー実行では設定推奨）
 *        SLACK_WEBHOOK_URL  Slack Incoming Webhook の URL（未設定なら Slack 通知はスキップ）
 *   2. previewReport() を実行して権限を承認し、「月次レポート」シートの内容を確認（通知は送らない）
 *   3. setupMonthlyTrigger() を 1 回実行 → 毎月 1 日に runMonthlyReport() が自動実行される
 */

/** 動作設定（スクリプト プロパティにしない固定値） */
var REPORT_CONFIG = {
  sourceSheetName: '売上データ', // CSV_FOLDER_ID 未設定時に読むシート名
  reportSheetName: '月次レポート', // 出力先シート名（無ければ作成）
  csvCharset: 'UTF-8', // Excel で保存した CSV なら 'Shift_JIS'
  topN: 5, // 上位 N 件
  triggerHour: 9, // 毎月 1 日の何時に実行するか（0〜23・スクリプトのタイムゾーン）
  mailSubjectPrefix: '[月次売上レポート]',
  manualTargetMonth: '2026-08', // runReportFor() で集計する月（エディタから任意の月を手動実行する用）
  // 列名が違う CSV を使うときはここで上書き（例: { date: '売上日', product: '品名' }）
  columns: {},
};

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/** トリガーから毎月 1 日に呼ばれる: 前月分を集計して通知する */
function runMonthlyReport() {
  runReport_(prevMonthOf(monthKeyOf(new Date())), true);
}

/** 手動確認用: データ中の最新月を集計してシートに書くだけ（メール・Slack は送らない） */
function previewReport() {
  runReport_(null, false);
}

/** 任意の月（REPORT_CONFIG.manualTargetMonth）を集計して通知する。過去月の再送・手動実行用 */
function runReportFor() {
  runReport_(REPORT_CONFIG.manualTargetMonth, true);
}

/**
 * 集計 → シート出力 → 通知 の本体
 * @param {string|null} targetMonth 'YYYY-MM'（null ならデータ中の最新月）
 * @param {boolean} notify true ならメール・Slack を送る
 */
function runReport_(targetMonth, notify) {
  var loaded = loadRecords_();
  var report = buildReport(loaded.records, {
    targetMonth: targetMonth,
    topN: REPORT_CONFIG.topN,
  });
  writeReportSheet_(toSheetRows(report));
  var text = formatText(report);
  Logger.log(text);
  if (!notify) {
    Logger.log('（プレビューのため通知は送信していません）');
    return;
  }
  sendMail_(report, text);
  postSlack_(formatSlack(report));
}

// ---------------------------------------------------------------------------
// 入力: CSV（Drive）またはシート
// ---------------------------------------------------------------------------

/** 売上データを読み込んで正規化する。不正行があればログに残す */
function loadRecords_() {
  var folderId = PropertiesService.getScriptProperties().getProperty('CSV_FOLDER_ID');
  var rows;
  if (folderId) {
    var file = newestCsvIn_(folderId);
    Logger.log('CSV を読み込み: %s（更新 %s）', file.getName(), file.getLastUpdated());
    rows = csvToObjects(file.getBlob().getDataAsString(REPORT_CONFIG.csvCharset)).rows;
  } else {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPORT_CONFIG.sourceSheetName);
    if (!sheet) {
      throw new Error(
        'シート「' + REPORT_CONFIG.sourceSheetName + '」がありません。CSV を貼り付けるか、スクリプト プロパティ CSV_FOLDER_ID を設定してください'
      );
    }
    rows = valuesToObjects(sheet.getDataRange().getValues()).rows;
  }
  var result = normalizeRecords(rows, REPORT_CONFIG.columns);
  if (result.skipped.length) {
    Logger.log(
      '%s 行をスキップ:\n%s',
      result.skipped.length,
      result.skipped
        .map(function (s) {
          return '  行' + s.line + ': ' + s.reason;
        })
        .join('\n')
    );
  }
  return result;
}

/** フォルダ内で最も新しい CSV ファイルを返す */
function newestCsvIn_(folderId) {
  var files = DriveApp.getFolderById(folderId).getFiles();
  var newest = null;
  while (files.hasNext()) {
    var f = files.next();
    if (!/\.csv$/i.test(f.getName())) continue;
    if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
  }
  if (!newest) throw new Error('フォルダ内に CSV ファイルがありません: ' + folderId);
  return newest;
}

// ---------------------------------------------------------------------------
// 出力: 「月次レポート」シート
// ---------------------------------------------------------------------------

/** 2 次元配列をレポートシートに書き込み、見出しの書式を整える */
function writeReportSheet_(rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(REPORT_CONFIG.reportSheetName) || ss.insertSheet(REPORT_CONFIG.reportSheetName);
  sheet.clear();
  var width = rows[0].length;
  var range = sheet.getRange(1, 1, rows.length, width);
  // 先にセル書式を敷く: 数値は #,##0、文字列は '@'（書式なしテキスト）。
  // setValues は "2026-08" を日付、"+4.2%" を 0.042 に自動変換するため、文字列セルは '@' で保護する
  range.setNumberFormats(rows.map(function (r) {
    return r.map(function (v) {
      return typeof v === 'number' ? '#,##0' : '@';
    });
  }));
  range.setValues(rows);
  sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  rows.forEach(function (r, i) {
    if (String(r[0]).charAt(0) === '■') {
      sheet.getRange(i + 1, 1, 1, width).setFontWeight('bold').setBackground('#e8f0fe');
    } else if (r[0] === '項目' || r[0] === '順位' || r[0] === '月') {
      sheet.getRange(i + 1, 1, 1, width).setFontWeight('bold').setBorder(null, null, true, null, null, null);
    }
  });
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, width);
  // autoResizeColumns は全角文字の幅を過小評価して商品名などが切れるため、表示幅（全角=2）から列幅を下支えする（タイトル行は除く）
  for (var c = 0; c < width; c++) {
    var maxW = rows.slice(1).reduce(function (m, r) { return Math.max(m, displayWidth(r[c])); }, 0);
    sheet.setColumnWidth(c + 1, Math.max(sheet.getColumnWidth(c + 1), 14 + maxW * 7));
  }
  Logger.log('「%s」シートに %s 行を書き込みました', REPORT_CONFIG.reportSheetName, rows.length);
}

// ---------------------------------------------------------------------------
// 通知: メール / Slack
// ---------------------------------------------------------------------------

/**
 * メール送信（宛先はスクリプト プロパティ MAIL_TO）
 * 未設定時は getEffectiveUser（トリガーの所有者）で補うが、トリガー実行では空になる場合があるので MAIL_TO の設定を推奨
 */
function sendMail_(report, text) {
  var to = PropertiesService.getScriptProperties().getProperty('MAIL_TO') || Session.getEffectiveUser().getEmail();
  if (!to) {
    Logger.log('宛先が決まらないためメールをスキップ（MAIL_TO を設定してください）');
    return;
  }
  MailApp.sendEmail({
    to: to,
    subject: REPORT_CONFIG.mailSubjectPrefix + ' ' + monthLabel(report.targetMonth),
    body: text,
  });
  Logger.log('メールを送信: %s', to);
}

/** Slack Incoming Webhook へ投稿（URL はスクリプト プロパティ SLACK_WEBHOOK_URL） */
function postSlack_(payload) {
  var url = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!url) {
    Logger.log('SLACK_WEBHOOK_URL が未設定のため Slack 通知をスキップ');
    return;
  }
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Slack 通知に失敗: HTTP ' + res.getResponseCode() + ' ' + res.getContentText());
  }
  Logger.log('Slack に投稿しました');
}

// ---------------------------------------------------------------------------
// トリガー（毎月 1 日に自動実行）
// ---------------------------------------------------------------------------

/** 毎月 1 日 REPORT_CONFIG.triggerHour 時に runMonthlyReport を実行するトリガーを作る（重複は作らない） */
function setupMonthlyTrigger() {
  deleteMonthlyTrigger();
  ScriptApp.newTrigger('runMonthlyReport').timeBased().onMonthDay(1).atHour(REPORT_CONFIG.triggerHour).create();
  Logger.log('毎月 1 日 %s 時に runMonthlyReport を実行するトリガーを作成しました', REPORT_CONFIG.triggerHour);
}

/** runMonthlyReport のトリガーをすべて削除する */
function deleteMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runMonthlyReport') ScriptApp.deleteTrigger(t);
  });
}
