/**
 * estat-to-sheet (GAS 版) — e-Stat 公式 API (getStatsData) → Google スプレッドシート自動更新
 *
 * 導入:
 *   1. スプレッドシートを開き 拡張機能 → Apps Script でこのコードを貼り付ける
 *   2. プロジェクトの設定 → スクリプト プロパティ に ESTAT_APP_ID = <アプリケーション ID> を追加
 *      （appId はコードに書かない。取得手順は README）
 *   3. CONFIG.STATS_DATA_ID を目的の統計表 ID に変えて updateSheet() を一度手動実行（権限承認）
 *   4. installWeeklyTrigger() を一度実行 → 毎週月曜 6 時台に自動更新
 *
 * 出所表示（e-Stat API 利用規約 第7条）: 更新のたびに <SHEET_NAME>_meta シートへ書き込む
 */
var CONFIG = {
  STATS_DATA_ID: '0003410379', // 取得したい統計表 ID（e-Stat の統計表ページ URL の sid= の値）
  SHEET_NAME: 'estat',         // 書き込み先シート（無ければ作成・毎回全置換）
  LIMIT: 100000,               // 1 リクエストの取得件数（API 上限 100,000）
  SLEEP_MS: 1000,              // ページ間の待機（規約第8条: 短時間の大量アクセス禁止）
  RETRIES: 3,                  // 一時エラー時の再試行回数
  EXTRA_PARAMS: {},            // 絞り込み例: { cdArea: '13000' }
  WRITE_CHUNK_ROWS: 10000      // setValues を分割する行数
};

var BASE_URL = 'https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData';
var CREDIT = 'このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、サービスの内容は国によって保証されたものではありません。';

/** メイン: 全ページ取得 → 表に整形 → シート全置換 → meta 更新 */
function updateSheet() {
  var appId = PropertiesService.getScriptProperties().getProperty('ESTAT_APP_ID');
  if (!appId) throw new Error('スクリプト プロパティ ESTAT_APP_ID が未設定です（README 導入手順を参照）');

  try {
    var pages = fetchAllPages_(appId, CONFIG.STATS_DATA_ID, CONFIG.LIMIT, CONFIG.EXTRA_PARAMS);
    var table = pagesToTable_(pages);
    writeTable_(CONFIG.SHEET_NAME, table.header, table.rows);
    writeMeta_(CONFIG.SHEET_NAME + '_meta', pages, table.rows.length);
    Logger.log('%s 行を %s に書き込みました', table.rows.length, CONFIG.SHEET_NAME);
  } catch (e) {
    // 失敗通知メール・ログに appId を残さない
    throw new Error(redact_(e && e.message ? e.message : e));
  }
}

/** URL 付きの例外メッセージから appId を隠す（ログ・失敗通知メール対策） */
function redact_(s) {
  return String(s).replace(/appId=[^&\s]+/g, 'appId=***');
}

/** 毎週月曜 6 時台（日本時間）のトリガーを（重複なく）作る */
function installWeeklyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('updateSheet')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(6)
    .inTimezone('Asia/Tokyo')
    .create();
  Logger.log('毎週月曜 6 時台（Asia/Tokyo）に updateSheet を実行するトリガーを作成しました');
}

/** このスクリプトが作った updateSheet トリガーを全て削除 */
function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'updateSheet') ScriptApp.deleteTrigger(t);
  });
}

// ---------------------------------------------------------------- fetching
function buildUrl_(appId, statsDataId, startPosition, limit, extra) {
  var params = {
    appId: appId,
    statsDataId: statsDataId,
    startPosition: startPosition,
    limit: limit,
    metaGetFlg: 'Y'
  };
  Object.keys(extra || {}).forEach(function (k) { params[k] = extra[k]; });
  var qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  return BASE_URL + '?' + qs;
}

/** NEXT_KEY が無くなるまで取得（ページ間スリープ・進まない NEXT_KEY は打ち切り） */
function fetchAllPages_(appId, statsDataId, limit, extra) {
  var pages = [];
  var start = 1;
  for (;;) {
    var payload = fetchJsonWithRetry_(buildUrl_(appId, statsDataId, start, limit, extra));
    var status = checkStatus_(payload);
    pages.push(payload);
    var rinf = statisticalData_(payload).RESULT_INF || {};
    Logger.log('取得 %s-%s / %s 件', rinf.FROM_NUMBER, rinf.TO_NUMBER, rinf.TOTAL_NUMBER);
    var nextKey = Number(rinf.NEXT_KEY);
    if (status === 1 || !nextKey || nextKey <= start) break;
    start = nextKey;
    Utilities.sleep(CONFIG.SLEEP_MS);
  }
  return pages;
}

/** 一時エラー（429/5xx/ネットワーク/JSON 破損）は指数バックオフで再試行 */
function fetchJsonWithRetry_(url) {
  var lastErr = null;
  for (var attempt = 0; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      var code = resp.getResponseCode();
      if (code === 200) return JSON.parse(resp.getContentText('UTF-8'));
      if ([429, 500, 502, 503, 504].indexOf(code) === -1) {
        throw new Error('HTTP ' + code + ': ' + resp.getContentText().slice(0, 200));
      }
      lastErr = new Error('HTTP ' + code);
    } catch (e) {
      if (/^HTTP \d+:/.test(String(e.message))) throw e; // 再試行しないエラー
      lastErr = e;
    }
    if (attempt < CONFIG.RETRIES) {
      var waitMs = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
      Logger.log('再試行 %s/%s（%s ms 後）: %s', attempt + 1, CONFIG.RETRIES, waitMs, redact_(lastErr));
      Utilities.sleep(waitMs);
    }
  }
  throw new Error('取得に失敗しました（再試行 ' + CONFIG.RETRIES + ' 回）: ' + redact_(lastErr));
}

// ---------------------------------------------------------------- parsing（Python 版と同じ整形）
function asList_(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

/** RESULT.STATUS: 0=正常, 1=該当データなし, 100 以上=エラー */
function checkStatus_(payload) {
  var root = payload && payload.GET_STATS_DATA;
  if (!root) throw new Error('応答に GET_STATS_DATA がありません');
  var result = root.RESULT || {};
  var status = Number(result.STATUS);
  if (status !== 0 && status !== 1) {
    throw new Error('e-Stat API エラー STATUS=' + result.STATUS + ': ' + (result.ERROR_MSG || ''));
  }
  return status;
}

function statisticalData_(payload) {
  return payload.GET_STATS_DATA.STATISTICAL_DATA || {};
}

/** CLASS_INF → [{id, name, codes:{code:name}, units:{code:unit}}]（出現順） */
function buildClassMaps_(sd) {
  return asList_((sd.CLASS_INF || {}).CLASS_OBJ).map(function (obj) {
    var codes = {}, units = {};
    asList_(obj.CLASS).forEach(function (cls) {
      var code = String(cls['@code'] || '');
      codes[code] = cls['@name'] || '';
      if (cls['@unit']) units[code] = cls['@unit'];
    });
    return { id: obj['@id'] || '', name: obj['@name'] || obj['@id'] || '', codes: codes, units: units };
  });
}

function headerFor_(classMaps) {
  var seen = {}, header = [];
  classMaps.forEach(function (cm) {
    var name = cm.name;
    if (seen[name] || name === '単位' || name === '値') name = name + '[' + cm.id + ']';
    seen[name] = true;
    header.push(name + 'コード', name);
  });
  header.push('単位', '値');
  return header;
}

function valuesToRows_(sd, classMaps) {
  var tabUnits = {};
  classMaps.forEach(function (cm) { if (cm.id === 'tab') tabUnits = cm.units; });
  return asList_((sd.DATA_INF || {}).VALUE).map(function (v) {
    var row = [];
    classMaps.forEach(function (cm) {
      var code = String(v['@' + cm.id] === undefined ? '' : v['@' + cm.id]);
      row.push(code, cm.codes[code] || '');
    });
    var unit = v['@unit'] || tabUnits[String(v['@tab'] || '')] || '';
    var value = v['$'] === undefined ? '' : v['$'];
    var num = Number(value);
    row.push(unit, value !== '' && !isNaN(num) ? num : value); // 数値はセルに数値として入れる
    return row;
  });
}

function pagesToTable_(pages) {
  var header = null, rows = [], classMaps = null;
  pages.forEach(function (payload) {
    var sd = statisticalData_(payload);
    if (!classMaps) {
      classMaps = buildClassMaps_(sd);
      header = headerFor_(classMaps);
    }
    rows = rows.concat(valuesToRows_(sd, classMaps));
  });
  return { header: header || ['単位', '値'], rows: rows };
}

// ---------------------------------------------------------------- writing
function getOrCreateSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** シートを全置換（見出し 1 行 + データ）。大きい表は分割して書く */
function writeTable_(sheetName, header, rows) {
  var sheet = getOrCreateSheet_(sheetName);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  // コード列（奇数列・最後の「単位」「値」を除く）は文字列書式にして先頭ゼロ（"00000" 等）を守る
  var n = Math.max(rows.length, 1);
  for (var c = 1; c < header.length - 1; c += 2) {
    sheet.getRange(2, c, n, 1).setNumberFormat('@');
  }
  for (var i = 0; i < rows.length; i += CONFIG.WRITE_CHUNK_ROWS) {
    var chunk = rows.slice(i, i + CONFIG.WRITE_CHUNK_ROWS);
    sheet.getRange(i + 2, 1, chunk.length, header.length).setValues(chunk);
  }
  sheet.setFrozenRows(1);
}

/** 更新日時・統計表 ID・件数・出所表示を meta シートに残す */
function writeMeta_(sheetName, pages, rowCount) {
  var first = pages[0] ? statisticalData_(pages[0]) : {};
  var tinf = first.TABLE_INF || {};
  var statName = tinf.STAT_NAME && tinf.STAT_NAME['$'] ? tinf.STAT_NAME['$'] : '';
  var title = tinf.TITLE && tinf.TITLE['$'] ? tinf.TITLE['$'] : (tinf.TITLE || '');
  var rows = [
    ['更新日時', new Date()],
    ['統計表 ID', CONFIG.STATS_DATA_ID],
    ['統計名', statName],
    ['表題', title],
    ['件数', rowCount],
    ['出所', CREDIT],
    ['出典', '政府統計の総合窓口(e-Stat) https://www.e-stat.go.jp/']
  ];
  var sheet = getOrCreateSheet_(sheetName);
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
}
