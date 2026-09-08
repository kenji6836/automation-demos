/**
 * inquiry-reply-assistant — GAS 版
 * Gmail の指定ラベルの未読メール → Claude API（要約・分類・緊急度・返信下書き）→ Gmail 下書きを作成
 *
 * 設定（Apps Script エディタ「プロジェクトの設定」→「スクリプト プロパティ」）:
 *   ANTHROPIC_API_KEY   必須。Claude API キー（コードに書かない）
 *   INQUIRY_LABEL       処理対象のラベル名（既定 "問い合わせ"）
 *   DONE_LABEL          処理済みに付けるラベル名（既定 "問い合わせ/下書き済"）。無ければ自動作成
 *   COMPANY_NAME        会社名（既定 "サンプル株式会社"）
 *   DEPARTMENT          部署名（既定 "カスタマーサポート"）
 *   TONE                口調（既定 "丁寧で簡潔なビジネス日本語（です・ます調）"）
 *   SIGNATURE           実際の署名。設定すると下書き内のプレースホルダ [[署名]] を置き換える
 *   MODEL               モデル ID（既定 "claude-haiku-4-5"）
 *   MAX_THREADS         1 回の実行で処理する最大スレッド数（既定 10）
 *   PROCESSED_MESSAGE_IDS  スクリプトが自動管理（処理済みメッセージ ID・直近 300 件）。手で編集不要
 *
 * 使い方:
 *   1. 上記プロパティを設定
 *   2. エディタで processInquiries を 1 回手動実行して権限を承認
 *   3. installTrigger を 1 回実行 → 15 分ごとに自動実行
 *
 * プロンプトはリポジトリの prompts/system.txt・prompts/user.txt と同じ内容（GAS はローカルファイルを読めないため複製）。
 * 変更時は両方を更新すること。
 */

var API_URL = 'https://api.anthropic.com/v1/messages';
var API_VERSION = '2023-06-01';
var DEFAULT_MODEL = 'claude-haiku-4-5';
var MAX_TOKENS = 2048;
var SIGNATURE_PLACEHOLDER = '[[署名]]';
var TRIGGER_EVERY_MINUTES = 15;

var SYSTEM_PROMPT_TEMPLATE = [
  'あなたは $company_name（$department）の問い合わせ対応アシスタントです。',
  '届いた問い合わせメールを読み、担当者が確認してから送るための「要約」「分類」「緊急度」「返信下書き」を作成します。',
  '',
  '## 出力項目',
  '- summary: 問い合わせの要点を日本語で3行。配列の要素を3つ、各要素は1文（40字程度まで）。',
  '- category: 「見積依頼」「不具合」「その他」のいずれか。営業・宣伝・勧誘のメールは「その他」。',
  '- urgency: 「高」「中」「低」。障害・業務停止・金銭被害・期限が差し迫っている場合は「高」、通常の問い合わせは「中」、営業・情報提供・急ぎでないものは「低」。',
  '- urgency_reason: 緊急度の根拠を1文。',
  '- reply_draft: $tone で書いた返信本文。',
  '',
  '## 返信下書きのルール',
  '- 構成は「宛名 → 挨拶（お問い合わせへの感謝）→ 本文 → 結び → 署名」。',
  '- 事実はメール本文に書かれていることだけを使う。不明な点は断定せず「確認のうえご連絡します」「差し支えなければ〜をお知らせください」のように書く。',
  '- 金額・納期・日付・対応可否を勝手に約束しない。見積依頼には、見積に必要な確認事項（数量・希望納期など）を尋ねる。',
  '- 不具合報告には、状況把握のために必要な情報（発生日時・環境・再現手順・スクリーンショットなど）を丁寧に依頼する。',
  '- 営業・勧誘メールには、短く丁重にお断りする（「必要になった際はこちらからご連絡します」など）。',
  '- 差出人の氏名がメールに書かれていれば「◯◯様」と宛名に使う。書かれていなければ「ご担当者様」。',
  '- 署名は本文の最後に必ず「$signature_placeholder」という文字列をそのまま1行で入れる（担当者が実際の署名に置き換えます）。',
  '- 返信本文以外の解説・注釈は書かない。',
].join('\n');

var USER_PROMPT_TEMPLATE = '以下の問い合わせメールを処理してください。\n\n<inquiry>\n$inquiry\n</inquiry>\n';

var OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'array', items: { type: 'string' }, description: '問い合わせの要点。日本語で3行（配列要素3つ）' },
    category: { type: 'string', enum: ['見積依頼', '不具合', 'その他'] },
    urgency: { type: 'string', enum: ['高', '中', '低'] },
    urgency_reason: { type: 'string' },
    reply_draft: { type: 'string' },
  },
  required: ['summary', 'category', 'urgency', 'urgency_reason', 'reply_draft'],
  additionalProperties: false,
};

/** 設定をスクリプトプロパティから読む */
function loadConfig_() {
  var p = PropertiesService.getScriptProperties();
  var apiKey = p.getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('スクリプトプロパティ ANTHROPIC_API_KEY が未設定です');
  return {
    apiKey: apiKey,
    inquiryLabel: p.getProperty('INQUIRY_LABEL') || '問い合わせ',
    doneLabel: p.getProperty('DONE_LABEL') || '問い合わせ/下書き済',
    company_name: p.getProperty('COMPANY_NAME') || 'サンプル株式会社',
    department: p.getProperty('DEPARTMENT') || 'カスタマーサポート',
    tone: p.getProperty('TONE') || '丁寧で簡潔なビジネス日本語（です・ます調）',
    signature: p.getProperty('SIGNATURE') || '',
    signature_placeholder: SIGNATURE_PLACEHOLDER,
    model: p.getProperty('MODEL') || DEFAULT_MODEL,
    maxThreads: parseInt(p.getProperty('MAX_THREADS') || '10', 10),
  };
}

/** プロンプトに差し込む値だけを取り出す（API キー等をテンプレート置換に渡さない） */
function promptValues_(cfg) {
  return {
    company_name: cfg.company_name,
    department: cfg.department,
    tone: cfg.tone,
    signature_placeholder: cfg.signature_placeholder,
  };
}

/** `$name` 形式のプレースホルダ置換（Python 版 string.Template と同じ書式。未知の名前はそのまま残す） */
function fillTemplate_(template, values) {
  return template.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, function (m, key) {
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : m;
  });
}

/** メイン: 未読の問い合わせを処理して下書きを作る（時間主導トリガーから呼ばれる） */
function processInquiries() {
  // 手動実行とトリガーが重なっても同じメールを二重処理しないよう、検索前にロックを取る
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    console.log('別の実行が進行中のためスキップしました');
    return;
  }
  try {
    processInquiriesLocked_();
  } finally {
    lock.releaseLock();
  }
}

function processInquiriesLocked_() {
  var cfg = loadConfig_();
  var doneLabel = GmailApp.getUserLabelByName(cfg.doneLabel) || GmailApp.createLabel(cfg.doneLabel);
  var query = 'label:"' + cfg.inquiryLabel + '" is:unread -label:"' + cfg.doneLabel + '"';
  var threads = GmailApp.search(query, 0, cfg.maxThreads);
  console.log('対象スレッド: ' + threads.length + ' 件 (' + query + ')');
  var processed = loadProcessedIds_();

  var ok = 0, ng = 0;
  threads.forEach(function (thread) {
    // 対象は「未読・下書きでない・未処理」のメッセージのうち最新のもの
    var message = latestUnreadMessage_(thread.getMessages(), processed);
    if (!message) {
      thread.addLabel(doneLabel); // 処理済みメッセージしか残っていないスレッドは次回の検索から外す
      return;
    }
    try {
      var inquiryText = 'From: ' + message.getFrom() + '\n' +
        'Subject: ' + message.getSubject() + '\n' +
        'Date: ' + message.getDate() + '\n\n' +
        message.getPlainBody();
      var result = callClaude_(inquiryText, cfg);
      message.createDraftReply(buildDraftBody_(result, cfg));
      processed[message.getId()] = true;
      saveProcessedIds_(processed);
      // API 処理中に同じスレッドへ新着が届いていたら DONE を付けず、次回にその新着だけを処理する
      if (latestUnreadMessage_(thread.getMessages(), processed)) {
        console.log('新着あり・次回処理: ' + message.getSubject());
      } else {
        thread.addLabel(doneLabel);
      }
      ok++;
      console.log('[OK] ' + message.getSubject() + ' → ' + result.category + ' / 緊急度 ' + result.urgency +
        ' (in ' + result.usage.input_tokens + ', out ' + result.usage.output_tokens + ' tok)');
    } catch (e) {
      ng++;
      // 本文はログに残さない（件名のみ）
      console.error('[NG] ' + message.getSubject() + ': ' + e.message);
    }
  });
  console.log('完了: 成功 ' + ok + ' / 失敗 ' + ng);
}

/** スレッド内の未読・下書きでない・未処理のメッセージのうち最新のものを返す（無ければ null） */
function latestUnreadMessage_(messages, processed) {
  for (var i = messages.length - 1; i >= 0; i--) {
    var m = messages[i];
    if (m.isUnread() && !m.isDraft() && !processed[m.getId()]) return m;
  }
  return null;
}

var PROCESSED_IDS_KEY = 'PROCESSED_MESSAGE_IDS';
var PROCESSED_IDS_MAX = 300; // スクリプトプロパティ 1 値 9KB 上限内に収める（16 桁 ID × 300 ≈ 5.7KB）

/** 処理済みメッセージ ID（スクリプトプロパティ・直近 PROCESSED_IDS_MAX 件）を { id: true } で返す */
function loadProcessedIds_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROCESSED_IDS_KEY);
  var ids = raw ? JSON.parse(raw) : [];
  var map = {};
  ids.forEach(function (id) { map[id] = true; });
  return map;
}

function saveProcessedIds_(map) {
  var ids = Object.keys(map).slice(-PROCESSED_IDS_MAX);
  PropertiesService.getScriptProperties().setProperty(PROCESSED_IDS_KEY, JSON.stringify(ids));
}

/** Claude Messages API を呼び、構造化結果を返す */
function callClaude_(inquiryText, cfg) {
  var body = {
    model: cfg.model,
    max_tokens: MAX_TOKENS,
    system: fillTemplate_(SYSTEM_PROMPT_TEMPLATE, promptValues_(cfg)),
    messages: [{ role: 'user', content: fillTemplate_(USER_PROMPT_TEMPLATE, { inquiry: inquiryText }) }],
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  };
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': API_VERSION },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  };
  var response = null;
  for (var attempt = 1; attempt <= 3; attempt++) {
    response = UrlFetchApp.fetch(API_URL, options);
    var status = response.getResponseCode();
    if (status === 200) break;
    var retryable = status === 429 || status === 500 || status === 529;
    if (!retryable || attempt === 3) {
      throw new Error('Claude API HTTP ' + status + ': ' + errorDetail_(response.getContentText()));
    }
    Utilities.sleep(2000 * attempt);
  }
  var resp = JSON.parse(response.getContentText());
  if (resp.stop_reason === 'refusal') throw new Error('モデルが応答を拒否しました (refusal)');
  if (resp.stop_reason === 'max_tokens') throw new Error('出力が max_tokens で打ち切られました');
  var textBlock = (resp.content || []).filter(function (b) { return b.type === 'text'; })[0];
  if (!textBlock) throw new Error('応答にテキストブロックがありません');
  var data = JSON.parse(textBlock.text);
  ['summary', 'category', 'urgency', 'urgency_reason', 'reply_draft'].forEach(function (k) {
    if (!(k in data)) throw new Error('応答 JSON に ' + k + ' がありません');
  });
  data.summary = Array.isArray(data.summary) ? data.summary : String(data.summary).split('\n');
  data.usage = resp.usage || { input_tokens: 0, output_tokens: 0 };
  return data;
}

function errorDetail_(text) {
  try {
    var e = JSON.parse(text).error || {};
    return (e.type || 'error') + ' - ' + (e.message || '');
  } catch (ignore) {
    return String(text).slice(0, 200);
  }
}

/** 下書き本文: 先頭に AI メモ（担当者が送信前に削除）＋返信下書き */
function buildDraftBody_(result, cfg) {
  var memo = [
    '【AI 下書きメモ — 送信前にこのブロックを削除してください】',
    '分類: ' + result.category + ' / 緊急度: ' + result.urgency + '（' + result.urgency_reason + '）',
    '要約:',
  ].concat(result.summary.map(function (s, i) { return '  ' + (i + 1) + '. ' + s; }))
    .concat(['------------------------------------------------', '']);
  var draft = result.reply_draft;
  if (cfg.signature) draft = draft.split(cfg.signature_placeholder).join(cfg.signature);
  return memo.join('\n') + draft;
}

/** 時間主導トリガーを 1 本だけ設置する（重複防止のため既存分は削除） */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInquiries') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInquiries').timeBased().everyMinutes(TRIGGER_EVERY_MINUTES).create();
  console.log(TRIGGER_EVERY_MINUTES + ' 分ごとのトリガーを設置しました');
}

/** トリガーを外す */
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInquiries') ScriptApp.deleteTrigger(t);
  });
  console.log('トリガーを削除しました');
}
