#!/usr/bin/env python3
"""html_scrape_example.py — 標準ライブラリ（html.parser / urllib.robotparser）だけで
HTML の「見出し＋箇条書き」または「表」を CSV にする最小例。Python 3.9 以上。

同梱の静的フィクスチャは自サイト（https://kenji6836.github.io/apps/sweepfield/index.html）を
1 回だけ取得して保存したもの。第三者サイトに向ける前の確認手順は
README「HTML スクレイピングが必要な場合」を参照。

使い方（ローカル HTML）:
    python3 html_scrape_example.py --html tests/fixtures/kenji6836_sweepfield_support.html \
        --out examples/scrape_output.csv
    python3 html_scrape_example.py --html page.html --mode table --out tables.csv

使い方（URL 直接。robots.txt を確認し、Disallow なら取得しない）:
    python3 html_scrape_example.py --url https://kenji6836.github.io/apps/sweepfield/index.html --out out.csv
"""
import argparse
import csv
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser

USER_AGENT = "estat-to-sheet-demo/1.0 (+https://github.com/kenji6836/automation-demos)"
DEFAULT_DELAY = 2.0  # robots.txt に Crawl-delay が無いときの最低待機秒


def clean(text):
    return " ".join(text.split())


# ---------------------------------------------------------------- list mode
class ListItemExtractor(HTMLParser):
    """見出し(h1-h3)を「セクション」として追跡し、<li> ごとに 1 行を作る。

    行 = {section, no, label(<strong>/<b> の中身), text(残りの本文), links(href を ; 区切り)}
    ネストした <li> は兄弟として扱う（最小例のため）。
    """
    HEADINGS = ("h1", "h2", "h3")

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.rows = []
        self._section = ""
        self._counts = {}
        self._in_title = False
        self._heading_tag = None
        self._heading_buf = []
        self._item = None
        self._in_label = False
        self._skip_depth = 0  # <script>/<style> の中

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip_depth += 1
            return
        attrs = dict(attrs)
        if tag == "title":
            self._in_title = True
        elif tag in self.HEADINGS:
            self._heading_tag = tag
            self._heading_buf = []
        elif tag == "li":
            if self._item is not None:
                self._flush_item()
            self._item = {"label": [], "text": [], "links": []}
        elif self._item is not None:
            if tag in ("strong", "b"):
                self._in_label = True
            elif tag == "a" and attrs.get("href"):
                self._item["links"].append(attrs["href"])

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if tag == "title":
            self._in_title = False
        elif tag in self.HEADINGS and tag == self._heading_tag:
            self._section = clean("".join(self._heading_buf))
            self._heading_tag = None
        elif tag == "li" and self._item is not None:
            self._flush_item()
        elif tag in ("strong", "b"):
            self._in_label = False

    def handle_data(self, data):
        if self._skip_depth:
            return
        if self._in_title:
            self.title += data
        if self._heading_tag:
            self._heading_buf.append(data)
        if self._item is not None:
            key = "label" if self._in_label else "text"
            self._item[key].append(data)

    def _flush_item(self):
        item, self._item = self._item, None
        self._counts[self._section] = self._counts.get(self._section, 0) + 1
        self.rows.append({
            "section": self._section,
            "no": self._counts[self._section],
            "label": clean("".join(item["label"])),
            "text": clean("".join(item["text"])),
            "links": ";".join(item["links"]),
        })

    def close(self):
        super().close()
        if self._item is not None:
            self._flush_item()
        self.title = clean(self.title)


def extract_list_items(html):
    parser = ListItemExtractor()
    parser.feed(html)
    parser.close()
    return parser.title, parser.rows


# ---------------------------------------------------------------- table mode
class TableExtractor(HTMLParser):
    """<table> ごとに <tr> を 1 行、<th>/<td> をセルとして取り出す。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []  # [[[cell, ...], ...], ...]
        self._row = None
        self._cell = None

    # HTML5 では </td> </th> </tr> は省略可なので、次の要素が始まった時点で前のものを確定する
    def _end_cell(self):
        if self._cell is not None:
            self._row.append(clean("".join(self._cell)))
            self._cell = None

    def _end_row(self):
        if self._row is not None:
            self._end_cell()
            self.tables[-1].append(self._row)
            self._row = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._end_row()
            self.tables.append([])
        elif tag == "tr" and self.tables:
            self._end_row()
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._end_cell()
            self._cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            self._end_cell()
        elif tag in ("tr", "table"):
            self._end_row()

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def extract_tables(html):
    parser = TableExtractor()
    parser.feed(html)
    parser.close()
    return parser.tables


def tables_to_rows(tables):
    """複数の表を 1 枚の CSV 用に平坦化: table, row, col1..colN。"""
    width = max((len(r) for t in tables for r in t), default=0)
    header = ["table", "row"] + ["col%d" % (i + 1) for i in range(width)]
    rows = []
    for t_no, table in enumerate(tables, 1):
        for r_no, cells in enumerate(table, 1):
            rows.append([t_no, r_no] + cells + [""] * (width - len(cells)))
    return header, rows


# ---------------------------------------------------------------- fetching (robots 確認つき)
def robots_allows(url, user_agent=USER_AGENT, robots_text=None, fetch=None):
    """robots.txt を確認し (取得してよいか, Crawl-delay 秒 or None) を返す。

    robots_text を渡せばネットワーク不要（テスト用）。
    robots.txt が無い(404)場合は許可、401/403 や 5xx（読めない）は安全側で不許可。
    """
    parts = urllib.parse.urlsplit(url)
    robots_url = urllib.parse.urlunsplit((parts.scheme, parts.netloc, "/robots.txt", "", ""))
    rp = urllib.robotparser.RobotFileParser(robots_url)
    if robots_text is None:
        fetch = fetch or _http_get_text
        try:
            robots_text = fetch(robots_url)
        except urllib.error.HTTPError as err:
            if err.code in (401, 403) or err.code >= 500:
                return False, None
            robots_text = ""  # 404 など = robots.txt なし
    rp.parse(robots_text.splitlines())
    product = user_agent.split("/")[0]
    return rp.can_fetch(product, url), rp.crawl_delay(product)


def _http_get_text(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"  # Shift_JIS 等のサイトにも対応
        return resp.read().decode(charset, errors="replace")


def fetch_html(url, delay=DEFAULT_DELAY, sleep=time.sleep, fetch=None, log=None):
    """robots.txt を確認してから 1 ページ取得。Disallow なら例外。"""
    allowed, crawl_delay = robots_allows(url, fetch=fetch)
    if not allowed:
        raise PermissionError("robots.txt で取得が許可されていません: %s" % url)
    wait = max(delay, crawl_delay or 0)
    if log:
        log("robots.txt: 許可（待機 %.0f 秒・UA=%s）" % (wait, USER_AGENT))
    sleep(wait)
    return (fetch or _http_get_text)(url)


# ---------------------------------------------------------------- CLI
def main(argv=None):
    parser = argparse.ArgumentParser(description="HTML の箇条書き／表 → CSV（標準ライブラリのみ）")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--html", help="ローカル HTML ファイル")
    src.add_argument("--url", help="取得する URL（robots.txt を確認・待機してから 1 回だけ取得）")
    parser.add_argument("--mode", choices=("list", "table"), default="list")
    parser.add_argument("--out", default="scrape.csv")
    parser.add_argument("--encoding", default="utf-8-sig")
    args = parser.parse_args(argv)

    def log(msg):
        print(msg, file=sys.stderr)

    try:
        if args.html:
            with open(args.html, "r", encoding="utf-8", errors="replace") as fh:
                html = fh.read()
        else:
            html = fetch_html(args.url, log=log)
        if args.mode == "list":
            title, items = extract_list_items(html)
            header = ["page_title", "section", "no", "label", "text", "links"]
            rows = [[title, r["section"], r["no"], r["label"], r["text"], r["links"]] for r in items]
        else:
            header, rows = tables_to_rows(extract_tables(html))
        with open(args.out, "w", newline="", encoding=args.encoding) as fh:
            writer = csv.writer(fh)
            writer.writerow(header)
            writer.writerows(rows)
    except (OSError, PermissionError, urllib.error.URLError) as err:
        log("エラー: %s" % err)
        return 1
    log("%d 行を %s に書き出しました" % (len(rows), args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
