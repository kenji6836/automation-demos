# gas-sales-report — 売上 CSV → スプレッドシート月次集計 → メール / Slack 通知

Google Apps Script（GAS）で「毎月の売上集計とレポート配信」を自動化するデモです。

- 売上 CSV（日付・商品・数量・単価・担当者・顧客 …）を取り込み、**月次 × 商品／月次 × 担当者** の集計・**前月比**・**上位 N** を算出
- 結果を「**月次レポート**」シートに書き出し、**メール**（プレーンテキスト）と **Slack**（Incoming Webhook）に同じ内容を通知
- **毎月 1 日に自動実行**（時間主導トリガー）。集計ロジックは純関数に分離してあり、Google アカウント無しでも `node --test` で検証できます

## 画面イメージ（ローカル実行の実出力）

同梱の `sales.csv`（サンプル 200 行・2026 年 3〜8 月）を `node scripts/run-local.js` で集計した実際の出力です。
GAS 上ではこの表がそのまま「月次レポート」シートに `setValues()` され、下のメール本文と Slack ペイロードが送信されます。

> スプレッドシート画面・Slack 投稿の GIF は、Google アカウント接続後に追加します（現時点ではローカル実行の出力のみ掲載）。

### 「月次レポート」シートに書き込まれる内容

```text
月次売上レポート 2026年8月
集計対象  2026-08  比較対象（前月）  2026-07

■ サマリー
項目           当月     前月  前月比
売上金額    344,000  330,020   +4.2%
販売数量        165      115  +43.5%
注文件数         31       28  +10.7%
取引顧客数        8

■ 商品別 上位5（全9商品）
順位  商品名                          売上金額  数量  構成比  前月売上   前月比
   1  コピー用紙 A4 5000枚             139,300    35   40.5%   107,460   +29.6%
   2  トナーカートリッジ                64,000     5   18.6%    89,600   -28.6%
   3  付箋 5色セット                    30,380    49    8.8%     9,920  +206.3%
   4  ボールペン 黒 10本入              25,520    29    7.4%    24,640    +3.6%
   5  ウェットティッシュ 業務用         24,320    19    7.1%    26,880    -9.5%
   -  オフィスチェア（当月実績なし）         0     0    0.0%    49,600  -100.0%

■ 担当者別 上位5（全5名）
順位  担当者  売上金額  数量  構成比  前月売上   前月比
   1  佐藤     101,320    63   29.5%    64,500   +57.1%
   2  高橋      86,000    28   25.0%   147,140   -41.6%
   3  伊藤      65,340    29   19.0%    34,220   +90.9%
   4  鈴木      53,920    19   15.7%    20,720  +160.2%
   5  田中      37,420    26   10.9%    63,440   -41.0%

■ 月次推移
月       売上金額  数量  注文件数  前月比
2026-03   486,200   180        38       -
2026-04   542,000   210        38  +11.5%
2026-05   370,700   132        30  -31.6%
2026-06   385,940   184        35   +4.1%
2026-07   330,020   115        28  -14.5%
2026-08   344,000   165        31   +4.2%
```

### メール本文（プレーンテキスト）

```text
【月次売上レポート】2026年8月
対象: 2026-08（前月比は 2026年7月 との比較）

■ サマリー
売上金額: ¥344,000（前月 ¥330,020 / +4.2%）
販売数量: 165（前月 115 / +43.5%）
注文件数: 31（前月 28 / +10.7%）
取引顧客数: 8

■ 商品別 上位5
1. コピー用紙 A4 5000枚 ¥139,300（構成比 40.5% / 前月比 +29.6%）
2. トナーカートリッジ ¥64,000（構成比 18.6% / 前月比 -28.6%）
3. 付箋 5色セット ¥30,380（構成比 8.8% / 前月比 +206.3%）
4. ボールペン 黒 10本入 ¥25,520（構成比 7.4% / 前月比 +3.6%）
5. ウェットティッシュ 業務用 ¥24,320（構成比 7.1% / 前月比 -9.5%）
当月実績なし: オフィスチェア（前月 ¥49,600）

■ 担当者別 上位5
1. 佐藤 ¥101,320（9件 / 前月比 +57.1%）
2. 高橋 ¥86,000（5件 / 前月比 -41.6%）
3. 伊藤 ¥65,340（7件 / 前月比 +90.9%）
4. 鈴木 ¥53,920（4件 / 前月比 +160.2%）
5. 田中 ¥37,420（6件 / 前月比 -41.0%）

■ 月次推移
2026-03  ¥486,200（38件 / -）
2026-04  ¥542,000（38件 / +11.5%）
2026-05  ¥370,700（30件 / -31.6%）
2026-06  ¥385,940（35件 / +4.1%）
2026-07  ¥330,020（28件 / -14.5%）
2026-08  ¥344,000（31件 / +4.2%）

詳細はスプレッドシート「月次レポート」シートを参照してください。
```

### Slack 通知（Incoming Webhook 用 JSON・Block Kit）

<details>
<summary>ペイロード全文を開く</summary>

```json
{
  "text": "月次売上レポート 2026年8月: 売上 ¥344,000（前月比 +4.2%）",
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "月次売上レポート 2026年8月",
        "emoji": true
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*売上金額 ¥344,000*  前月比 +4.2% :chart_with_upwards_trend:"
      }
    },
    {
      "type": "section",
      "fields": [
        {
          "type": "mrkdwn",
          "text": "*販売数量*\n165（+43.5%）"
        },
        {
          "type": "mrkdwn",
          "text": "*注文件数*\n31（+10.7%）"
        },
        {
          "type": "mrkdwn",
          "text": "*前月売上*\n¥330,020"
        },
        {
          "type": "mrkdwn",
          "text": "*取引顧客数*\n8"
        }
      ]
    },
    {
      "type": "divider"
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*商品別 上位5*\n1. コピー用紙 A4 5000枚  ¥139,300（+29.6%）\n2. トナーカートリッジ  ¥64,000（-28.6%）\n3. 付箋 5色セット  ¥30,380（+206.3%）\n4. ボールペン 黒 10本入  ¥25,520（+3.6%）\n5. ウェットティッシュ 業務用  ¥24,320（-9.5%）\n_当月実績なし: オフィスチェア（前月 ¥49,600）_"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*担当者別 上位5*\n1. 佐藤  ¥101,320（+57.1%）\n2. 高橋  ¥86,000（-41.6%）\n3. 伊藤  ¥65,340（+90.9%）\n4. 鈴木  ¥53,920（+160.2%）\n5. 田中  ¥37,420（-41.0%）"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "対象: 2026-08 ／ 詳細はスプレッドシート「月次レポート」シート"
        }
      ]
    }
  ]
}
```

</details>

## 構成

```text
gas-sales-report/
├── Code.gs                 GAS 側の薄いラッパ（SpreadsheetApp / DriveApp / MailApp / UrlFetchApp / ScriptApp）
├── src/report.js           集計・整形の純関数（GAS と Node.js の両方でそのまま動く）
├── appsscript.json         GAS マニフェスト（タイムゾーン Asia/Tokyo・V8）
├── sales.csv               サンプル売上データ 200 行（scripts/generate-sales.js で再生成可）
├── scripts/run-local.js    ローカル実行（表・メール本文・Slack JSON を表示）
├── scripts/generate-sales.js  サンプルデータ生成（seed 固定）
├── test/report.test.js     集計ロジックのテスト（node --test・追加依存なし）
├── test/code-gs.test.js    GAS サービスをスタブにした Code.gs のスモークテスト
├── .clasp.json.example     clasp 用設定の雛形（scriptId を入れて .clasp.json にコピー）
└── .claspignore            clasp push の対象を Code.gs / src/report.js / appsscript.json に限定
```

処理の流れ:

```text
sales.csv ──parseCsv──▶ 行オブジェクト ──normalizeRecords──▶ 正規化レコード
   ──buildReport──▶ レポート構造 ──┬─ toSheetRows ──▶ 「月次レポート」シート
                                   ├─ formatText  ──▶ メール本文
                                   └─ formatSlack ──▶ Slack Incoming Webhook
```

## ローカルで試す（Google アカウント不要）

```bash
cd gas-sales-report
node --test                          # テスト 32 件（集計ロジック + GAS スタブでの Code.gs スモーク）
node scripts/run-local.js            # 最新月（2026-08）・上位 5 を表示
node scripts/run-local.js --month 2026-07 --top 3 --only mail   # 月・件数・出力を指定
node scripts/run-local.js --csv path/to/your.csv                # 自分の CSV で試す
```

Node.js 20 以上。npm パッケージのインストールは不要です。

## 導入手順

### A. Apps Script エディタに貼り付ける（clasp 不要）

1. Google スプレッドシートを新規作成し、メニュー **拡張機能 → Apps Script** を開く
2. 既定の `コード.gs` の中身を `Code.gs` の内容で置き換える
3. エディタ左の「ファイル」欄の **＋ → スクリプト** で `report` というファイルを追加し、`src/report.js` の内容を貼り付ける（GAS では同じプロジェクト内の関数を共有するので、そのまま呼び出せます）
4. 売上データを用意する（どちらか）
   - **シート方式**: スプレッドシートに `売上データ` シートを作り、`sales.csv` の内容を貼り付ける（**ファイル → インポート** でも可）
   - **Drive 方式**: Google ドライブにフォルダを作って CSV を置き、URL 末尾のフォルダ ID をスクリプト プロパティ `CSV_FOLDER_ID` に設定する（フォルダ内で最も新しい CSV が読まれます）
5. **プロジェクトの設定 → スクリプト プロパティ** に必要な値を登録する（値はコードに書きません）

   | プロパティ | 必須 | 内容 |
   |---|---|---|
   | `CSV_FOLDER_ID` | 任意 | CSV を置く Drive フォルダの ID（未設定なら `売上データ` シートを読む） |
   | `MAIL_TO` | 推奨 | 通知メール宛先（カンマ区切りで複数可）。未設定時はトリガー所有者宛を試みますが、トリガー実行ではアドレスが取れず送信をスキップすることがあります |
   | `SLACK_WEBHOOK_URL` | 任意 | Slack Incoming Webhook の URL（未設定なら Slack 通知をスキップ） |

6. エディタで関数 **`previewReport`** を選んで実行 → 権限の承認 → 「月次レポート」シートに結果が書かれる（通知は送られません）
7. 関数 **`setupMonthlyTrigger`** を 1 回実行 → 毎月 1 日 9 時（`REPORT_CONFIG.triggerHour`）に `runMonthlyReport` が動き、**前月分**を集計して通知します
   - 手動で通知まで試す: `REPORT_CONFIG.manualTargetMonth` に月を書いて **`runReportFor`** を実行
   - 止める: **`deleteMonthlyTrigger`** を実行

### B. clasp でデプロイする（コマンドラインで管理したい場合）

```bash
npm install -g @google/clasp
clasp login                                   # ブラウザで Google アカウントにログイン
cd gas-sales-report
clasp create --type sheets --title "月次売上レポート" --rootDir .   # 新規（スプレッドシート付きで作成）
#   既存プロジェクトに紐付ける場合: cp .clasp.json.example .clasp.json して scriptId を記入
clasp push                                    # Code.gs / src/report.js / appsscript.json だけが送られる（.claspignore）。リモートはローカル一式で上書きされる
clasp open                                    # エディタを開き、上記 A-5〜7（プロパティ設定・previewReport・setupMonthlyTrigger）を行う
```

`clasp create` が生成した `.clasp.json` は `.gitignore` 済みなので、スクリプト ID がリポジトリに入ることはありません。

## カスタマイズ例

### 列名が違う CSV を使う

`Code.gs` の `REPORT_CONFIG.columns` で対応付けを上書きします（既定は `日付 / 商品名 / カテゴリ / 数量 / 単価 / 担当者 / 顧客名`）。

```js
columns: { date: '売上日', product: '品名', qty: '個数', unitPrice: '税抜単価', staff: '営業担当' },
```

### 集計軸を追加する（例: 地域別）

`sales.csv` には `地域` 列も入っています。`src/report.js` の `normalizeRecords` でレコードに列を持たせ、`buildReport` で `rankBy` を 1 行足すだけで新しいランキングが作れます。

```js
// normalizeRecords(): レコードに region を追加
region: String(row['地域'] == null ? '' : row['地域']).trim(),

// buildReport(): 地域別ランキングを追加（products / staff と同じ形）
var regions = rankBy(current, previous, 'region', opt.topN);
// → 戻り値に regions.ranking を含め、toSheetRows / formatText / formatSlack に「■ 地域別」の節を足す
```

### 通知先を変える

- **メール宛先**: スクリプト プロパティ `MAIL_TO` を変更（複数は `a@example.com,b@example.com`）
- **Slack のチャンネル**: Webhook はチャンネル単位なので、目的のチャンネルで Incoming Webhook を作り直して `SLACK_WEBHOOK_URL` を差し替え
- **Chatwork / LINE / Teams など**: `Code.gs` の `postSlack_()` と同じ要領で `UrlFetchApp.fetch()` を呼ぶ関数を足し、`runReport_()` から呼びます。本文は `formatText(report)` をそのまま使えます

### その他

- **上位 N 件**: `REPORT_CONFIG.topN`
- **実行時刻**: `REPORT_CONFIG.triggerHour`（`setupMonthlyTrigger` を再実行して反映）
- **Excel（Shift_JIS）の CSV**: `REPORT_CONFIG.csvCharset` を `'Shift_JIS'` に
- **数量 × 単価ではなく金額列を使う**: `normalizeRecords` の `amount` を `toNumber(row['金額'])` に変更

## 制約・注意

- MailApp の 1 日あたりの送信数は Google アカウントの種類で上限があります（無料アカウントは 100 通/日）。月 1 通の本用途では問題ありません
- トリガーの実行時刻はスクリプトのタイムゾーン（`appsscript.json` の `Asia/Tokyo`）基準で、指定時刻から最大 1 時間程度ずれることがあります
- 前月にデータが無い場合、前月比は `-`（比較不能）と表示されます
- 前月に売上があり当月ゼロの商品・担当者は、ランキング末尾に「（当月実績なし）」として前月比 -100% で表示します（上位 N の件数には含めません）
- 返品・値引きは数量または単価をマイナスにした行で表せます（`-2` のほか会計表記の `(1,000)` も読めます）
