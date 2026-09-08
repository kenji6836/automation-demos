"""html_scrape_example.py の unittest（ネットワーク不使用）。"""
import contextlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import html_scrape_example as hs  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def read_fixture(name):
    with open(os.path.join(FIXTURES, name), "r", encoding="utf-8") as fh:
        return fh.read()


class ListModeTest(unittest.TestCase):
    def test_extracts_faq_items_under_heading(self):
        title, rows = hs.extract_list_items(read_fixture("kenji6836_sweepfield_support.html"))
        self.assertEqual(title, "Sweepfield - Support")
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(r["section"] == "FAQ" for r in rows))
        self.assertEqual([r["no"] for r in rows], [1, 2, 3])
        self.assertEqual(rows[0]["label"], "Is every board really solvable without guessing?")
        self.assertTrue(rows[0]["text"].startswith("Yes. Every board"))
        self.assertNotIn("<", rows[2]["text"])  # タグが混ざらない
        self.assertEqual(rows[0]["links"], "")

    def test_links_and_nested_sections(self):
        html = """<html><head><title> T </title><style>li{color:red}</style></head><body>
        <h2>A</h2><ul><li><b>x</b> one <a href="/a">A</a></li><li>two</li></ul>
        <h3>B &amp; C</h3><ol><li>three <a href="/b">B</a> <a href="/c">C</a></li></ol>
        <script>var li = "<li>fake</li>";</script></body></html>"""
        title, rows = hs.extract_list_items(html)
        self.assertEqual(title, "T")
        self.assertEqual([(r["section"], r["no"]) for r in rows], [("A", 1), ("A", 2), ("B & C", 1)])
        self.assertEqual(rows[0]["label"], "x")
        self.assertEqual(rows[0]["text"], "one A")
        self.assertEqual(rows[0]["links"], "/a")
        self.assertEqual(rows[2]["links"], "/b;/c")


class TableModeTest(unittest.TestCase):
    def test_tables_to_rows_pads_to_widest_row(self):
        html = """<table><tr><th>都道府県</th><th>人口</th></tr>
        <tr><td>東京都</td><td>14,000,000</td></tr><tr><td>大阪府</td></tr></table>
        <table><tr><td>a</td><td>b</td><td>c</td></tr></table>"""
        header, rows = hs.tables_to_rows(hs.extract_tables(html))
        self.assertEqual(header, ["table", "row", "col1", "col2", "col3"])
        self.assertEqual(rows[0], [1, 1, "都道府県", "人口", ""])
        self.assertEqual(rows[2], [1, 3, "大阪府", "", ""])
        self.assertEqual(rows[3], [2, 1, "a", "b", "c"])

    def test_omitted_end_tags_are_handled(self):
        # HTML5 で省略可能な </th> </td> </tr>（最後の </tr> も無し）
        html = ("<table><tr><th>都道府県<th>人口<tr><td>東京都<td>14000000"
                "<tr><td>大阪府<td>8800000</table><p>after</p>")
        tables = hs.extract_tables(html)
        self.assertEqual(tables, [[["都道府県", "人口"], ["東京都", "14000000"], ["大阪府", "8800000"]]])


class RobotsTest(unittest.TestCase):
    ROBOTS = "User-agent: *\nDisallow: /private/\nCrawl-delay: 5\n"

    def test_http_status_of_robots_txt(self):
        import urllib.error

        def raising(code):
            def fetch(url):
                raise urllib.error.HTTPError(url, code, "x", {}, None)
            return fetch

        url = "https://example.com/apps/x.html"
        self.assertEqual(hs.robots_allows(url, fetch=raising(404))[0], True)   # robots.txt なし
        self.assertEqual(hs.robots_allows(url, fetch=raising(403))[0], False)  # アクセス制限
        self.assertEqual(hs.robots_allows(url, fetch=raising(500))[0], False)  # 読めない→安全側

    def test_disallowed_path_is_refused_and_delay_read(self):
        allowed, delay = hs.robots_allows("https://example.com/private/x.html", robots_text=self.ROBOTS)
        self.assertFalse(allowed)
        allowed, delay = hs.robots_allows("https://example.com/apps/x.html", robots_text=self.ROBOTS)
        self.assertTrue(allowed)
        self.assertEqual(delay, 5)

    def test_fetch_html_refuses_disallowed_url_without_fetching_page(self):
        calls = []

        def fake_fetch(url):
            calls.append(url)
            return self.ROBOTS if url.endswith("/robots.txt") else "<html></html>"

        with self.assertRaises(PermissionError):
            hs.fetch_html("https://example.com/private/x.html", fetch=fake_fetch, sleep=lambda s: None)
        self.assertEqual(calls, ["https://example.com/robots.txt"])

    def test_fetch_html_waits_crawl_delay(self):
        waited = []

        def fake_fetch(url):
            return self.ROBOTS if url.endswith("/robots.txt") else "<html><title>ok</title></html>"

        html = hs.fetch_html("https://example.com/apps/x.html", delay=1, fetch=fake_fetch,
                             sleep=waited.append)
        self.assertEqual(waited, [5])  # Crawl-delay 5 > 既定 1
        self.assertIn("ok", html)


class CliTest(unittest.TestCase):
    def test_cli_list_mode_writes_csv(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "o.csv")
            with contextlib.redirect_stderr(io.StringIO()):
                rc = hs.main(["--html", os.path.join(FIXTURES, "kenji6836_sweepfield_support.html"),
                              "--out", out])
            self.assertEqual(rc, 0)
            with open(out, "r", encoding="utf-8-sig") as fh:
                lines = fh.read().splitlines()
            self.assertEqual(lines[0], "page_title,section,no,label,text,links")
            self.assertEqual(len(lines), 4)


if __name__ == "__main__":
    unittest.main()
