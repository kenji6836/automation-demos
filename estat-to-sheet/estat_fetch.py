#!/usr/bin/env python3
"""estat_fetch.py — e-Stat 公式 API (getStatsData) から統計表を取得し CSV に整形する。

- 標準ライブラリのみ（Python 3.9 以上）
- ページング（NEXT_KEY 追従）・再試行（指数バックオフ）・ページ間スリープ

使い方（appId は環境変数 ESTAT_APP_ID で渡す。引数に書くと shell 履歴に残るため）:
    export ESTAT_APP_ID=xxxxxxxx
    python3 estat_fetch.py --stats-data-id 0003410379 --out data.csv

オフライン確認（API の代わりにローカル JSON をページ順に読む）:
    python3 estat_fetch.py --stats-data-id 0003410379 \
        --from-file tests/fixtures/getStatsData_page1.json tests/fixtures/getStatsData_page2.json \
        --out examples/sample_output.csv
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData"
DEFAULT_LIMIT = 100000  # API の 1 リクエスト上限（仕様書 3.0）
RETRYABLE_HTTP = (429, 500, 502, 503, 504)
USER_AGENT = "estat-to-sheet/1.0 (automation-demos)"
# e-Stat API 利用規約第7条に基づく出所表示（README の出典表を参照）
CREDIT = (
    "このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、"
    "サービスの内容は国によって保証されたものではありません。"
)


class EstatError(Exception):
    """API がエラー STATUS を返した／再試行しても取得できなかった。"""


# ---------------------------------------------------------------- utilities
def as_list(value):
    """e-Stat の JSON は要素が 1 件だと dict、複数だと list になるので揃える。"""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def build_url(app_id, stats_data_id, start_position=1, limit=DEFAULT_LIMIT,
              extra=None, base_url=BASE_URL):
    params = {
        "appId": app_id,
        "statsDataId": stats_data_id,
        "startPosition": start_position,
        "limit": limit,
        "metaGetFlg": "Y",  # CLASS_INF（コード→名称）を含める
    }
    if extra:
        params.update(extra)
    return base_url + "?" + urllib.parse.urlencode(params)


def http_get_json(url, timeout=60):
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw.decode("utf-8"))


def fetch_with_retry(url, getter=http_get_json, retries=3, backoff=2.0,
                     sleep=time.sleep, log=None):
    """一時的なエラー（5xx/429/接続失敗/JSON 破損）は指数バックオフで再試行する。"""
    last_err = None
    for attempt in range(retries + 1):
        try:
            return getter(url)
        except urllib.error.HTTPError as err:  # URLError の派生なので先に捕まえる
            if err.code not in RETRYABLE_HTTP:
                raise
            last_err = err
        except (urllib.error.URLError, OSError, ValueError) as err:
            last_err = err
        if attempt < retries:
            wait = backoff ** (attempt + 1)
            if log:
                log("再試行 %d/%d（%.0f 秒後）: %s" % (attempt + 1, retries, wait, last_err))
            sleep(wait)
    raise EstatError("取得に失敗しました（再試行 %d 回）: %s" % (retries, last_err))


# ---------------------------------------------------------------- parsing
def check_status(payload):
    """RESULT.STATUS を検査。0=正常、1=該当データなし、100 以上=エラー。"""
    root = payload.get("GET_STATS_DATA") if isinstance(payload, dict) else None
    if root is None:
        raise EstatError("応答に GET_STATS_DATA がありません")
    result = root.get("RESULT") or {}
    try:
        status = int(result.get("STATUS", -1))
    except (TypeError, ValueError):
        status = -1
    if status not in (0, 1):
        raise EstatError("e-Stat API エラー STATUS=%s: %s"
                         % (result.get("STATUS"), result.get("ERROR_MSG", "")))
    return status


def statistical_data(payload):
    return payload["GET_STATS_DATA"].get("STATISTICAL_DATA") or {}


def result_message(payload):
    return (payload["GET_STATS_DATA"].get("RESULT") or {}).get("ERROR_MSG", "")


def build_class_maps(stat_data):
    """CLASS_INF を [{id, name, codes:{code:name}, units:{code:unit}}, ...]（出現順）に変換。"""
    maps = []
    for obj in as_list((stat_data.get("CLASS_INF") or {}).get("CLASS_OBJ")):
        codes, units = {}, {}
        for cls in as_list(obj.get("CLASS")):
            code = str(cls.get("@code", ""))
            codes[code] = cls.get("@name", "")
            if cls.get("@unit"):
                units[code] = cls["@unit"]
        maps.append({
            "id": obj.get("@id", ""),
            "name": obj.get("@name") or obj.get("@id", ""),
            "codes": codes,
            "units": units,
        })
    return maps


def header_for(class_maps):
    """列見出し: 各分類の「<名称>コード」「<名称>」＋「単位」「値」。同名分類は id で区別。"""
    seen = {}
    header = []
    for cm in class_maps:
        name = cm["name"]
        if name in seen or name in ("単位", "値"):
            name = "%s[%s]" % (name, cm["id"])
        seen[name] = True
        header.append(name + "コード")
        header.append(name)
    header.extend(["単位", "値"])
    return header


def values_to_rows(stat_data, class_maps):
    rows = []
    tab_units = next((cm["units"] for cm in class_maps if cm["id"] == "tab"), {})
    for v in as_list((stat_data.get("DATA_INF") or {}).get("VALUE")):
        row = []
        for cm in class_maps:
            code = str(v.get("@" + cm["id"], ""))
            row.append(code)
            row.append(cm["codes"].get(code, ""))
        unit = v.get("@unit") or tab_units.get(str(v.get("@tab", "")), "")
        row.append(unit)
        row.append(v.get("$", ""))
        rows.append(row)
    return rows


def pages_to_table(pages):
    """複数ページの応答を 1 つの表（header, rows）にまとめる。CLASS_INF は先頭ページを使う。"""
    header, rows, class_maps = None, [], None
    for payload in pages:
        sd = statistical_data(payload)
        if class_maps is None:
            class_maps = build_class_maps(sd)
            header = header_for(class_maps)
        rows.extend(values_to_rows(sd, class_maps))
    if header is None:
        header = ["単位", "値"]
    return header, rows


# ---------------------------------------------------------------- fetching
def fetch_all_pages(app_id, stats_data_id, limit=DEFAULT_LIMIT, page_sleep=1.0,
                    retries=3, extra=None, base_url=BASE_URL, getter=http_get_json,
                    sleep=time.sleep, log=None):
    """NEXT_KEY が無くなるまで取得し、ページ（生の応答）のリストを返す。"""
    pages = []
    start = 1
    while True:
        url = build_url(app_id, stats_data_id, start, limit, extra, base_url)
        payload = fetch_with_retry(url, getter=getter, retries=retries, sleep=sleep, log=log)
        status = check_status(payload)
        pages.append(payload)
        rinf = statistical_data(payload).get("RESULT_INF") or {}
        if log:
            if status == 1:
                log("該当データなし（STATUS=1）: %s" % result_message(payload))
            else:
                log("取得 %s-%s / %s 件" % (rinf.get("FROM_NUMBER", "?"),
                                           rinf.get("TO_NUMBER", "?"),
                                           rinf.get("TOTAL_NUMBER", "?")))
        next_key = rinf.get("NEXT_KEY")
        if status == 1 or not next_key:
            break
        next_start = int(next_key)
        if next_start <= start:  # 進まない NEXT_KEY は無限ループ防止で打ち切り
            break
        start = next_start
        sleep(page_sleep)  # レート配慮（規約第8条: 短時間の大量アクセス禁止）
    return pages


def load_pages_from_files(paths, log=None):
    pages = []
    for path in paths:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        if check_status(payload) == 1 and log:
            log("該当データなし（STATUS=1）: %s" % result_message(payload))
        pages.append(payload)
    return pages


def write_csv(path, header, rows, encoding="utf-8-sig"):
    with open(path, "w", newline="", encoding=encoding) as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        writer.writerows(rows)


def parse_extra_params(items):
    extra = {}
    for item in items or []:
        if "=" not in item:
            raise ValueError("--param は KEY=VALUE 形式で指定してください: %r" % item)
        key, value = item.split("=", 1)
        extra[key.strip()] = value.strip()
    return extra


# ---------------------------------------------------------------- CLI
def main(argv=None):
    parser = argparse.ArgumentParser(
        description="e-Stat API (getStatsData) → CSV。標準ライブラリのみ。")
    parser.add_argument("--stats-data-id", required=True, help="統計表 ID（例: 0003410379）")
    parser.add_argument("--app-id", default=os.environ.get("ESTAT_APP_ID"),
                        help="アプリケーション ID（省略時は環境変数 ESTAT_APP_ID）")
    parser.add_argument("--out", default="data.csv", help="出力 CSV パス（既定: data.csv）")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                        help="1 リクエストの取得件数（既定・上限 100000）")
    parser.add_argument("--sleep", type=float, default=1.0, help="ページ間の待機秒（既定 1.0）")
    parser.add_argument("--retries", type=int, default=3, help="再試行回数（既定 3）")
    parser.add_argument("--timeout", type=float, default=60, help="HTTP タイムアウト秒（既定 60）")
    parser.add_argument("--param", action="append", default=[], metavar="KEY=VALUE",
                        help="追加の絞り込みパラメータ（例: --param cdArea=13000）")
    parser.add_argument("--from-file", nargs="+", metavar="JSON",
                        help="API の代わりにローカル JSON をページ順に読む（オフライン確認用）")
    parser.add_argument("--encoding", default="utf-8-sig",
                        help="CSV の文字コード（既定 utf-8-sig = Excel でも文字化けしない）")
    parser.add_argument("--quiet", action="store_true", help="進捗を表示しない")
    args = parser.parse_args(argv)

    def log(msg):
        if not args.quiet:
            print(msg, file=sys.stderr)

    try:
        if args.from_file:
            pages = load_pages_from_files(args.from_file, log=log)
        else:
            if not args.app_id:
                parser.error("--app-id か環境変数 ESTAT_APP_ID が必要です"
                             "（取得手順は README の導入手順を参照）")
            extra = parse_extra_params(args.param)

            def getter(url):
                return http_get_json(url, timeout=args.timeout)

            pages = fetch_all_pages(args.app_id, args.stats_data_id, limit=args.limit,
                                    page_sleep=args.sleep, retries=args.retries,
                                    extra=extra, getter=getter, log=log)
        header, rows = pages_to_table(pages)
        write_csv(args.out, header, rows, encoding=args.encoding)
    except (EstatError, ValueError, OSError) as err:
        print("エラー: %s" % err, file=sys.stderr)
        return 1

    log("%d 行を %s に書き出しました" % (len(rows), args.out))
    log("出所表示: " + CREDIT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
