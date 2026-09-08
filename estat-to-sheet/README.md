# estat-to-sheet — e-Stat 公式 API → CSV / Google スプレッドシート自動更新

- 政府統計の総合窓口 **e-Stat の公式 API**（利用規約が明確・登録無料）から統計表を取得し、コード→名称を引いた **整形済み CSV** にします（Python 標準ライブラリのみ）
- 同じ整形を **Google Apps Script** で行い、指定シートを **毎週自動で上書き更新** します（appId はスクリプト プロパティで管理）
- ページング・再試行・アクセス間隔・出所表示まで組み込んだ「**規約を守る安全なデータ収集**」の見本です。HTML スクレイピングが必要な案件向けの最小実装と事前確認手順は [後半](#html-スクレイピングが必要な場合) にあります

## 出力例

`examples/sample_output.csv`（先頭 10 行）。**同梱フィクスチャ（仕様書の JSON 構造を再現したダミー値）を通した実行結果**です。実データは appId 登録後に差し替えます。

```csv
表章項目コード,表章項目,男女コード,男女,地域コード,地域,時間軸（年次）コード,時間軸（年次）,単位,値
020,人口,0,総数,00000,全国,2020000000,2020年,人,126100000
020,人口,1,男,00000,全国,2020000000,2020年,人,61300000
020,人口,2,女,00000,全国,2020000000,2020年,人,64800000
020,人口,0,総数,13000,東京都,2020000000,2020年,人,14000000
020,人口,1,男,13000,東京都,2020000000,2020年,人,6900000
020,人口,2,女,13000,東京都,2020000000,2020年,人,7100000
020,人口,0,総数,27000,大阪府,2020000000,2020年,人,8800000
020,人口,1,男,27000,大阪府,2020000000,2020年,人,4200000
020,人口,2,女,27000,大阪府,2020000000,2020年,人,4600000
```

- API が返す `@cat01=1` のようなコードを、同じ応答の `CLASS_INF` から名称（男）に引いています。列は統計表ごとの分類（表章項目・地域・時間軸…）が自動で並びます
- 上の例を再現するコマンド（ネットワーク不要）:

```sh
python3 estat_fetch.py --stats-data-id 0003410379 \
  --from-file tests/fixtures/getStatsData_page1.json tests/fixtures/getStatsData_page2.json \
  --out examples/sample_output.csv
```

## 導入手順

### 0. アプリケーション ID（appId）の取得 — 人が行う作業

e-Stat API の呼び出しには **利用登録（無料）で発行される appId が必須** です。取得はご自身のアカウントで行ってください（本ツールは登録を代行しません）。

1. ユーザ登録: https://www.e-stat.go.jp/mypage/user/preregister
2. ログイン後、マイページの **API 機能（アプリケーション ID 発行）** でアプリ名・URL（ローカル利用なら `http://localhost/` 等）を登録 → appId が発行される
3. 手順の公式説明: https://www.e-stat.go.jp/api/api-info/api-guide

appId は秘密情報として扱い、コードやリポジトリに書かず環境変数／スクリプト プロパティに置きます。

### 1. CLI（Python 3.9 以上・追加ライブラリ不要）

```sh
export ESTAT_APP_ID=xxxxxxxx            # 取得した appId
python3 estat_fetch.py --stats-data-id 0003410379 --out data.csv
```

| オプション | 既定 | 説明 |
|---|---|---|
| `--stats-data-id` | 必須 | 統計表 ID。e-Stat の統計表ページ URL `…/dbview?sid=0003410379` の `sid=` の値 |
| `--app-id` | 環境変数 `ESTAT_APP_ID` | アプリケーション ID（引数で渡すと shell 履歴に残るので環境変数推奨） |
| `--out` | `data.csv` | 出力 CSV パス |
| `--param KEY=VALUE` | なし | 絞り込み（例 `--param cdArea=13000`、`--param cdTime=2020000000`）。複数指定可 |
| `--limit` | 100000 | 1 リクエストの件数（API 上限）。超える表は `NEXT_KEY` を追って自動ページング |
| `--sleep` / `--retries` | 1.0 秒 / 3 回 | ページ間の待機・一時エラー（429/5xx/接続失敗）の指数バックオフ再試行 |
| `--timeout` | 60 秒 | HTTP タイムアウト |
| `--encoding` | utf-8-sig | Excel でそのまま開ける BOM 付き UTF-8 |
| `--from-file` | なし | API の代わりにローカル JSON を読む（オフライン確認・テスト用） |
| `--quiet` | なし | 進捗・出所表示文を出さない |

- 応答の `RESULT.STATUS` が 0 以外は判定してメッセージを表示します（1=該当データなし → 見出しのみの CSV／100 以上=エラー → 終了コード 1）
- 実行後に出所表示文を標準エラーに出します（利用規約 第7条・下記出典表）

### 2. GAS（Google スプレッドシートを毎週自動更新）

1. 更新したいスプレッドシートを開き **拡張機能 → Apps Script**、`gas/Code.gs` の内容を貼り付ける
2. **プロジェクトの設定 → スクリプト プロパティ** に `ESTAT_APP_ID` = appId を追加
3. `CONFIG.STATS_DATA_ID`（統計表 ID）と `CONFIG.SHEET_NAME`（書き込み先）を編集し、`updateSheet` を 1 回手動実行して権限を承認
4. `installWeeklyTrigger` を 1 回実行 → **毎週月曜 6 時台（日本時間）** に `updateSheet` が走り、シートを全置換します（`removeTriggers` で停止）
5. `<シート名>_meta` シートに更新日時・統計表 ID・件数・出所表示が毎回記録されます
6. コード列（地域コード `00000` 等）は文字列書式で書き込むので先頭ゼロが落ちません。エラー時の失敗通知メール／ログには appId が出ないようマスクしています

## 応用例

- **他の統計表**: `--stats-data-id` を変えるだけ（国勢調査・労働力調査・家計調査・経済センサス等、e-Stat のデータベース化された表すべて）。`--param cdArea=…` で都道府県や市区町村に絞れば取得量とアクセス回数を抑えられます
- **定点観測**: GAS 版のトリガー＋`_meta` シートで「毎週の更新日時と件数」が残るので、公表更新の追跡に使えます
- **自治体オープンデータ**: 多くの自治体が CSV / API（CKAN 等）で公開しています。本ツールの「取得 → コードを名称に引く → CSV/シート」の構造をそのまま流用できます（応答構造に合わせて `build_class_maps` / `values_to_rows` を差し替え）
- **複数表の結合**: 表ごとに CSV を出し、共通キー（地域コード・時間軸コード）で結合すれば市区町村別の集計表が作れます

## HTML スクレイピングが必要な場合

公式 API やオープンデータが無いサイトは HTML を直接取得することになります。最小実装 = [`html_scrape_example.py`](html_scrape_example.py)（標準ライブラリ `html.parser` / `urllib.robotparser` のみ。見出し＋箇条書き、または表を CSV にする）。同梱フィクスチャは **自サイト**（https://kenji6836.github.io/apps/sweepfield/index.html を 2026-09-08 に 1 回取得）なので規約上の問題はありません。出力例 = `examples/scrape_output.csv`。

**第三者サイトを対象にする前に必ず行う確認（この結果次第でお断りします）**

1. `robots.txt` の `Disallow` / `Crawl-delay` を確認し、禁止パスは取得しない（`html_scrape_example.py --url` は自動で確認し、Disallow・403・5xx で読めない場合は取得せず終了します）
2. 利用規約に「自動取得・クローリング・スクレイピングの禁止」条項が無いか確認する（ログインが必要なページ・会員限定データは対象外）
3. アクセス頻度は 1 リクエスト 1〜数秒以上の間隔、連絡先入りの User-Agent を明示、深夜帯など負荷の低い時間に実行する
4. 取得データの二次利用（再配布・商用利用・DB 化）が規約で禁止されていないか確認し、用途を社内分析など許容範囲に限定する
5. 上記 1〜4 のいずれかに抵触する場合、または規約が確認できない場合は、その案件は **お受けしません**（代替: 公式 API・オープンデータ・提供元への許諾依頼）

## テスト

```sh
python3 -m unittest            # estat-to-sheet/ で実行。ネットワーク不使用
```

- `tests/fixtures/getStatsData_*.json`: API 仕様書 3.0 の JSON 構造（`GET_STATS_DATA` → `RESULT` / `STATISTICAL_DATA` → `RESULT_INF` / `CLASS_INF` / `DATA_INF`）を再現。2 ページ分・エラー（STATUS=100）・該当なし（STATUS=1）
- 検証内容: ページング（`NEXT_KEY` 追従・ページ間スリープ・進まない `NEXT_KEY` の打ち切り）、再試行（一時エラーのみ・バックオフ秒）、dict/list ゆれの正規化、コード→名称、単位フォールバック、CSV 出力、HTML の終了タグ省略、robots.txt 判定（Disallow・Crawl-delay・404/403/5xx）

## ファイル構成

```
estat-to-sheet/
├── estat_fetch.py             # CLI: e-Stat API → CSV
├── gas/Code.gs                # GAS: e-Stat API → スプレッドシート（週次トリガー）
├── html_scrape_example.py     # 第2部: HTML → CSV（robots.txt 確認つき）
├── examples/                  # 出力例（フィクスチャ経由）
└── tests/                     # unittest + フィクスチャ
```

## 出典表（確認日 2026-09-08 JST）

| 事実 | 内容 | 出典 | 状態 |
|---|---|---|---|
| appId の要否 | 「API機能をご利用いただくには、政府統計の総合窓口(e-Stat)のユーザ登録が必要」。ユーザ登録後、マイページでアプリケーション ID を発行 | https://www.e-stat.go.jp/api/api-info/api-guide | ✅ 確認済 |
| エンドポイント | `https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData`（GET）。必須 `appId`・`statsDataId`、ページング `startPosition` / `limit`（上限 100,000）、続きは `NEXT_KEY` | https://www.e-stat.go.jp/api/api-info/e-stat-manual3-0 | ✅ 確認済 |
| JSON 応答構造 | `GET_STATS_DATA` → `RESULT`（`STATUS` 0=正常・1=該当なし・100 以上=エラー、`ERROR_MSG`）／`STATISTICAL_DATA` → `RESULT_INF`（`TOTAL_NUMBER`…`NEXT_KEY`）・`CLASS_INF.CLASS_OBJ[].CLASS`（`@code` `@name` `@unit`）・`DATA_INF.VALUE[]`（`@tab` `@cat01` `@area` `@time` `@unit` `$`） | 同上 | ✅ 確認済 |
| 利用規約の要点 | 第7条: 本機能を利用したサービスでは出所等を明示／第8条: 短時間の大量アクセスなど運用に支障を与える行為の禁止／第5条: 負荷状況によりアクセス制限あり | https://www.e-stat.go.jp/api/agreement | ✅ 確認済 |
| 出所表示の文言 | 「このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、サービスの内容は国によって保証されたものではありません。」表示場所の指定なし | https://www.e-stat.go.jp/api/api-info/credit | ✅ 確認済 |
| 統計表 ID の探し方 | 統計表ページ URL の `sid=` の値 | 経験則（公式ページの記載は未確認） | 🟡 推定 |
| 例に使った統計表 ID `0003410379` | 形式の例。実在する表の内容・名称は未確認（フィクスチャの値はダミー） | — | 🟡 推定 |

このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、サービスの内容は国によって保証されたものではありません。
