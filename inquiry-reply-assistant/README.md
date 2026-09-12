# inquiry-reply-assistant — 問い合わせメール → 要約＋返信下書き（Claude API）

- 問い合わせメール（テキスト）を読み、**要約 3 行／分類（見積依頼・不具合・その他）／緊急度（高・中・低）／返信下書き**を JSON と Markdown で出力します。
- 依存ゼロの Python CLI（標準ライブラリのみ・Python 3.9+）と、Gmail の未読メールから自動で下書きを作る **GAS 版** の 2 通り。
- 会社名・部署・口調は `config.json`、プロンプトは `prompts/` で差し替え可。**送信は必ず人が最終確認**してから行う前提のツールです。

> 受託サービス「AI 自動化ツール制作」のデモです。同梱の問い合わせ 3 通（`inquiries/`）は架空の内容で、宛先はすべて `example.*` ドメインです。

## 実出力例（同梱 3 通・モデル `claude-haiku-4-5`・2026-09-08 実行）

`drafts/` にそのまま入っています（`*.md` が人が読む用、`*.json` が構造化データ）。以下は `drafts/*.md` からの転記です。

### 1. 見積依頼（`inquiries/01_estimate.txt` → `drafts/01_estimate.md`）

- 分類: **見積依頼**／緊急度: **中** — 年内稼働開始という期限がありますが、現時点では事前準備段階のため、通常の見積依頼として中程度の優先度です。
- 要約:
  1. Excel基の在庫管理システムをWeb化したいとのことで、概算見積を依頼されています。
  2. 商品マスタ登録・入出庫記録・在庫表示・CSVレポート出力など4つの主要機能をご希望です。
  3. 利用者は5〜10名程度で社内ネットワーク限定、年内稼働開始を目標としています。

<details><summary>返信下書き（クリックで展開）</summary>

```
高橋 美咲様

いつもお世話になっております。サンプル株式会社カスタマーサポートです。
このたびはご相談をいただき、ありがとうございます。

Excel基の在庫管理システムのWeb化についての概算見積のご依頼、承知いたしました。ご記載いただいた機能内容は理解できましたため、見積作成にあたり、以下の点についてご確認させていただけますでしょうか。

・商品マスタの登録・編集画面の詳細な仕様（検索・フィルタリング機能など）
・入出庫レコードの詳細情報（日時・数量・理由などの記録項目）
・月次レポートに含めたい情報項目
・セキュリティ要件（ユーザー認証・アクセス管理など）
・現在のExcelファイルをご提供いただけるか
・年内稼働開始の具体的な時期（例：12月末までなど）

上記の情報をいただければ、より正確な見積書をお作りいたします。差し支えなければお知らせください。

よろしくお願いいたします。

[[署名]]
```
</details>

### 2. 不具合報告（`inquiries/02_bug_report.txt` → `drafts/02_bug_report.md`）

- 分類: **不具合**／緊急度: **高** — 全社員が業務システムにアクセス不可で業務停止状態にあり、本日の勤怠締め日という期限が差し迫っているため。
- 要約:
  1. 勤怠管理システムが昨日17時から全社員80名でログイン不可になった。
  2. エラーコード E-503「認証サーバーに接続できません」が表示される。
  3. 本日が締め日のため、勤怠確定作業ができず至急対応が必要。

<details><summary>返信下書き（クリックで展開）</summary>

```
佐藤健一様

お世話になっております。サンプル株式会社カスタマーサポートです。
このたびはご報告いただきありがとうございます。

勤怠管理システムへのログイン障害について、大変お困りのことと存じます。早急に原因を調査させていただきます。

ご報告いただいた内容は確認いたしました。認証サーバーのエラーと複数環境での再現確認から、サーバー側の問題の可能性が高いと考えられます。現在、技術チームで状況確認を進めております。

恐れ入りますが、下記の追加情報をお知らせいただけますでしょうか。
・昨日17時ごろ、貴社側で特別な操作やシステム変更はございませんでしたか
・社内ネットワークの接続状況に異常はないでしょうか

確認のうえ、できるだけ早くご連絡いたします。本日の締め日対応が必要なことを踏まえ、対応を急ぎさせていただきます。

ご不便をおかけして申し訳ございません。何かご不明な点やお急ぎのご連絡がありましたら、お気軽にお声がけください。

[[署名]]
```
</details>

### 3. 営業メール（`inquiries/03_sales_pitch.txt` → `drafts/03_sales_pitch.md`）

- 分類: **その他**／緊急度: **低** — 営業・勧誘メールであり、対応は必須ではなく期限も設定されていないため。
- 要約:
  1. 複合機のリース費用見直しサービスの営業提案です。
  2. 月額費用を30～40%削減できる実績があると案内されています。
  3. 今月中の申し込みで初期費用無料のキャンペーン実施中とのこと。

<details><summary>返信下書き（クリックで展開）</summary>

```
株式会社エグザンプルオフィスサプライ 営業部 様

この度はご提案いただき、ありがとうございます。

貴社のサービスについて丁寧なご説明をいただきましたが、現在のところ弊社のオフィス機器については既存の契約で対応しており、新たなサービスの導入予定はございません。

ご提案いただきましたサービスのようなニーズが生じた際には、貴社にご相談させていただきたく存じます。この度はご連絡いただきありがとうございました。

[[署名]]
```
</details>

※ 出力は AI が生成した下書きそのままです（例: 1 通目の「Excel基」は「Excel ベース」の誤り）。**必ず人が読んで直してから送る**運用が前提です。`[[署名]]` は担当者の署名に置き換えます（GAS 版はスクリプトプロパティ `SIGNATURE` で自動置換可）。

## 導入手順

### A. CLI（Python 3.9+・追加インストール不要）

```bash
git clone <このリポジトリ> && cd automation-demos/inquiry-reply-assistant

# 1) 動作確認（API を呼ばずプロンプトだけ表示）
python3 reply_assistant.py --in inquiries/*.txt --out drafts/ --dry-run

# 2) 実行（API キーは環境変数で渡す。コードやファイルに書かない）
ANTHROPIC_API_KEY=sk-ant-... python3 reply_assistant.py --in inquiries/*.txt --out drafts/

#    macOS Keychain に登録済みなら（値は表示されない・プロセス内で読む）
python3 reply_assistant.py --keychain apiguard.ANTHROPIC_API_KEY --in inquiries/*.txt --out drafts/
```

- 入力: 1 通 1 ファイルのテキスト。先頭に `From:` / `Subject:` / `Date:` のヘッダ行があれば件名を Markdown の見出しに使います（無くても可）。
- 出力: `drafts/<入力名>.json`・`drafts/<入力名>.md`・`drafts/_usage.json`（合計トークンと概算費用）。
- 設定: `config.json`（会社名・部署・口調・署名プレースホルダ・モデル・max_tokens）。別ファイルは `--config` で指定。
- プロンプト: `prompts/system.txt`（役割とルール）・`prompts/user.txt`（本文の渡し方）。`$company_name` などのプレースホルダに `config.json` の値が入ります。
- モデル切替: `--model claude-sonnet-5`（または `config.json` の `model`）。既定はコスト最優先の `claude-haiku-4-5`。文面の質を上げたい場合は `claude-sonnet-5`（Haiku の約 2 倍の単価）、さらに上は `claude-opus-5`（約 5 倍）。`reply_assistant.py` の `PRICES_USD_PER_MTOK` に単価を持っています。
- 終了コード: 0=全件成功／1=一部失敗（失敗した通は標準エラーに理由）または明示した `--config` の読み込み失敗／2=API キー未設定・出力先の衝突で未実行。429/500/529 と接続エラーは最大 3 回リトライ、401/403 は即中断。
- テスト: `python3 -m unittest discover -s tests -v`（ネットワーク不使用・27 件）。

### B. GAS 版（Gmail の未読メール → 下書き自動作成）

1. Google Apps Script で新規プロジェクトを作り、`gas/Code.gs` の内容を貼り付ける。
2. 「プロジェクトの設定」→「スクリプト プロパティ」に `ANTHROPIC_API_KEY` を登録（コードに書かない）。任意で `INQUIRY_LABEL`（既定 `問い合わせ`）、`DONE_LABEL`（既定 `問い合わせ/下書き済`）、`COMPANY_NAME`、`DEPARTMENT`、`TONE`、`SIGNATURE`、`MODEL`、`MAX_THREADS`。
3. Gmail 側で、処理したい問い合わせに `INQUIRY_LABEL` のラベルが付くようフィルタを設定。
4. エディタで `processInquiries` を 1 回手動実行して権限を承認 → `installTrigger` を実行（15 分ごとの時間主導トリガーを 1 本設置。`removeTrigger` で解除）。

動作: `label:<INQUIRY_LABEL> is:unread -label:<DONE_LABEL>` のスレッドを最大 `MAX_THREADS` 件取り、各スレッドの「未読・未処理」の最新メッセージを Claude API に送り、**返信の下書き**（先頭に「AI 下書きメモ」= 分類・緊急度・要約、送信前に削除）を作成し `DONE_LABEL` を付けます。既読/未読は変えません。失敗したスレッドにはラベルを付けないので次回再試行されます。処理済みメッセージ ID をスクリプトプロパティに記録し、手動実行とトリガーの重なり（`LockService`）や処理中の新着があっても二重処理しません。プロンプトは CLI と同じ内容を `Code.gs` 内に複製しています（変更時は両方を更新）。

## 費用目安（2026-09-08 の実測から）

| 項目 | 値 |
|---|---|
| 実行 | 同梱 3 通を 1 回処理（API 呼び出し 3 回） |
| トークン | 入力 4,728 / 出力 1,482（3 通合計） |
| 概算費用 | **$0.0121 ≈ ¥1.8**（3 通） |
| 1 通あたり | 入力 約 1,580 / 出力 約 490 tok → **約 $0.004 ≈ ¥0.6** |
| 上限 ¥1,000 で処理できる通数 | **約 1,600 通**（同程度の長さの問い合わせなら） |

- 単価は Claude Haiku 4.5 の公開価格（入力 $1 / 出力 $5 per 1M tokens）。為替は **¥150/USD の固定概算（🟡 実際のレート・請求はご自身で確認）**。
- 入力の大半（約 1,000 tok）はシステムプロンプト。問い合わせが長いと入力側が増えます。Sonnet 5 に切り替えると約 2 倍、Opus 5 で約 5 倍が目安。

## 情報の取り扱い（実案件化時にお客様へ説明する内容）

**データの流れ**

- 問い合わせメールの本文（ヘッダの差出人・件名・日付を含む）は、要約・下書き作成のために **Anthropic の Claude API に送信**されます。
- 本ツールはメール本文を **ローカルやスプレッドシート等に保存しません**。CLI は入力ファイルを読み、生成結果（要約・下書き）だけを `drafts/` に書きます。GAS 版は Gmail の下書きを作るだけで、外部保存はありません。
- **ログに本文を残さない設計**です（CLI の標準出力はファイル名・分類・緊急度・トークン数のみ、GAS のログは件名のみ）。例外は CLI の `--dry-run` で、送信するプロンプト全文（問い合わせ本文を含む）を画面に表示します。API キーはコード・ファイルに書かず、環境変数／Keychain／スクリプトプロパティから読みます。

**Anthropic 側のデータ利用**

- ✅ Anthropic のプライバシーセンターは「By default, we will not use your inputs or outputs from our commercial products (e.g. Claude for Work, Anthropic API, Claude Gov, etc.) to train our models.」と明記しています（API 経由の入出力は既定で学習に使われない。確認日 2026-09-08 JST・出典は末尾）。
- 🟡 API 入出力の**保持期間**は同ページに明記がなく、Commercial Terms / Trust Center を参照する案内のみ。実案件では **利用規約・保持期間をお客様と一緒に確認**してください。

**GAS 版が要求する Gmail の権限（OAuth スコープ）**

- ✅ `GmailApp.search` / `createLabel` / `GmailMessage.getPlainBody` / `createDraftReply` 等が要求するスコープは **`https://mail.google.com/`**（Gmail の全権限。Apps Script 公式リファレンスで確認・2026-09-08 JST）。GmailApp サービスにはこれより狭い「読み取り＋下書きのみ」のスコープ指定は用意されていないため、承認画面ではメールの読み書き権限を求められます。
- 🟡 これに加え、時間主導トリガーの設置（`ScriptApp`）と外部 API 呼び出し（`UrlFetchApp`）のスコープが要求されます（一般に `…/auth/script.scriptapp` と `…/auth/script.external_request`。今回は未確認）。
- 権限を最小にしたい場合は、Advanced Gmail Service（Gmail API）で `gmail.readonly` + `gmail.compose` に絞る実装に変更できます（本デモの範囲外）。

**運用ルール**

- 個人情報・機密情報を含む問い合わせを AI に送る前に、**事前にお客様（利用企業）の同意**を得る。必要なら送信前にマスキングする。
- 下書きは **人間が内容を確認・修正してから送信**する（AI の誤り・言い過ぎ・約束の混入を防ぐ）。金額・納期などの約束はプロンプトで禁止していますが、最終責任は送信者にあります。
- 生成結果（`drafts/`・Gmail 下書き）の **保持期間はお客様のポリシーに従い**、不要になったら削除する。

## 構成

```
inquiry-reply-assistant/
├── reply_assistant.py      CLI 本体（標準ライブラリのみ）
├── config.json             会社名・口調・モデルなど
├── prompts/system.txt      役割・出力ルール（$company_name 等を置換）
├── prompts/user.txt        問い合わせ本文の渡し方
├── inquiries/*.txt         架空の問い合わせ 3 通
├── drafts/                 実出力（*.json / *.md / _usage.json）
├── gas/Code.gs             GAS 版
└── tests/                  unittest（ネットワーク不使用・応答はフィクスチャ）
```

## 出典（確認日 2026-09-08 JST）

- ✅ 価格: Anthropic 公式の価格ページ https://platform.claude.com/docs/en/about-claude/pricing （Claude Haiku 4.5 = 入力 $1 / 出力 $5 per MTok、Sonnet 5 = $2 / $10、Opus 5 = $5 / $25。2026-09-08 JST にライブ確認・Claude Code 同梱 `claude-api` スキルの価格表とも一致）
- ✅ モデル ID: 同スキルの現行モデル表（`claude-haiku-4-5`）。実行時に API が返した `model` は `claude-haiku-4-5-20251001`（`drafts/*.json`・2026-09-08）
- Messages API の呼び方（`POST /v1/messages`・`x-api-key`・`anthropic-version: 2023-06-01`・`output_config.format` の JSON Schema）: 同スキル `curl/examples.md`・`shared/tool-use-concepts.md`
- Anthropic のデータ利用方針: https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training
- Apps Script Gmail サービスのスコープ: https://developers.google.com/apps-script/reference/gmail/gmail-app ・ https://developers.google.com/apps-script/reference/gmail/gmail-message

## 建設/工務店 向けプロファイル

建設・工務店・リフォーム向けに、見積依頼や施工中の連絡を仕分けし、返信下書きを作る CLI 用デモです。
見積依頼には「概算は現地確認後にお伝えする」旨と確認事項を含め、金額の断定や工期の確約を避けます。

`inquiry-reply-assistant/` で実行します。まずはプロンプトを確認できます。

```bash
python3 reply_assistant.py \
  --in inquiries/kensetsu/*.txt \
  --out drafts/kensetsu/ \
  --config profiles/kensetsu/config.json \
  --prompts profiles/kensetsu/prompts \
  --dry-run
```

下書きを生成する場合は `--dry-run` を外します。`--dry-run` はプロンプトを表示して終了し、出力ファイルは作りません。
分類一覧は設定の `categories` で指定し、一覧外の分類は最後の要素に置き換えます。未指定時は従来の「見積依頼・不具合・その他」です。

| ファイル（`inquiries/kensetsu/`） | 想定分類 | 想定緊急度 |
|---|---|---|
| `01_reform_estimate.txt` | 見積依頼 | 中 |
| `02_gaikou_estimate.txt` | 見積依頼 | 中 |
| `03_shinchiku_soudan.txt` | 見積依頼 | 低 |
| `04_koji_renraku.txt` | 施工中の連絡 | 高 |
| `05_shizai_eigyo.txt` | その他 | 低 |

同梱5通は人名・社名・所在地を含めて架空の内容で、メールアドレスはすべて `example.*` ドメインです。写真添付の記載も架空で、画像ファイルは同梱していません。表は想定結果です。**送信は人が最終確認**してから行ってください。
