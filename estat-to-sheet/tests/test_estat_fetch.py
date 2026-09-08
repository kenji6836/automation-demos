"""estat_fetch.py の unittest（ネットワーク不使用・フィクスチャは仕様書 3.0 の JSON 構造を再現）。"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import estat_fetch as ef  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def load(name):
    with open(os.path.join(FIXTURES, name), "r", encoding="utf-8") as fh:
        return json.load(fh)


PAGE1 = "getStatsData_page1.json"
PAGE2 = "getStatsData_page2.json"
ERROR = "getStatsData_error.json"
NODATA = "getStatsData_nodata.json"


class HelpersTest(unittest.TestCase):
    def test_as_list_normalizes_dict_and_list(self):
        self.assertEqual(ef.as_list(None), [])
        self.assertEqual(ef.as_list({"a": 1}), [{"a": 1}])
        self.assertEqual(ef.as_list([1, 2]), [1, 2])

    def test_build_url_contains_required_and_extra_params(self):
        url = ef.build_url("APP", "0003410379", start_position=6, limit=5, extra={"cdArea": "13000"})
        self.assertTrue(url.startswith(ef.BASE_URL + "?"))
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        self.assertEqual(q, {"appId": "APP", "statsDataId": "0003410379", "startPosition": "6",
                             "limit": "5", "metaGetFlg": "Y", "cdArea": "13000"})

    def test_parse_extra_params(self):
        self.assertEqual(ef.parse_extra_params(["cdArea=13000", "cdTime = 2020000000"]),
                         {"cdArea": "13000", "cdTime": "2020000000"})
        with self.assertRaises(ValueError):
            ef.parse_extra_params(["nonsense"])


class ParsingTest(unittest.TestCase):
    def test_check_status_ok_nodata_error(self):
        self.assertEqual(ef.check_status(load(PAGE1)), 0)
        self.assertEqual(ef.check_status(load(NODATA)), 1)
        with self.assertRaises(ef.EstatError) as ctx:
            ef.check_status(load(ERROR))
        self.assertIn("STATUS=100", str(ctx.exception))
        self.assertIn("アプリケーションIDが不正です", str(ctx.exception))
        with self.assertRaises(ef.EstatError):
            ef.check_status({"unexpected": True})

    def test_class_maps_handle_single_dict_and_list(self):
        maps = ef.build_class_maps(ef.statistical_data(load(PAGE1)))
        self.assertEqual([m["id"] for m in maps], ["tab", "cat01", "area", "time"])
        self.assertEqual(maps[0]["codes"], {"020": "人口"})  # CLASS が dict のケース
        self.assertEqual(maps[0]["units"], {"020": "人"})
        self.assertEqual(maps[2]["codes"]["13000"], "東京都")  # CLASS が list のケース

    def test_single_page_rows_and_header(self):
        header, rows = ef.pages_to_table([load(PAGE1)])
        self.assertEqual(header, ["表章項目コード", "表章項目", "男女コード", "男女", "地域コード", "地域",
                                  "時間軸（年次）コード", "時間軸（年次）", "単位", "値"])
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[0], ["020", "人口", "0", "総数", "00000", "全国",
                                   "2020000000", "2020年", "人", "126100000"])
        self.assertEqual(rows[3][4:6], ["13000", "東京都"])

    def test_header_dedupes_same_class_names(self):
        maps = [{"id": "cat01", "name": "分類", "codes": {}, "units": {}},
                {"id": "cat02", "name": "分類", "codes": {}, "units": {}}]
        self.assertEqual(ef.header_for(maps),
                         ["分類コード", "分類", "分類[cat02]コード", "分類[cat02]", "単位", "値"])

    def test_unit_falls_back_to_tab_class_unit(self):
        payload = load(PAGE1)
        sd = ef.statistical_data(payload)
        for v in sd["DATA_INF"]["VALUE"]:
            del v["@unit"]
        _, rows = ef.pages_to_table([payload])
        self.assertTrue(all(r[-2] == "人" for r in rows))

    def test_nodata_yields_header_only(self):
        header, rows = ef.pages_to_table([load(NODATA)])
        self.assertEqual(rows, [])
        self.assertEqual(header[-2:], ["単位", "値"])


class PagingTest(unittest.TestCase):
    def test_follows_next_key_and_sleeps_between_pages(self):
        pages = {"1": load(PAGE1), "6": load(PAGE2)}
        urls, sleeps = [], []

        def getter(url):
            urls.append(url)
            start = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))["startPosition"]
            return pages[start]

        got = ef.fetch_all_pages("APP", "0003410379", limit=5, page_sleep=1.5,
                                 getter=getter, sleep=sleeps.append)
        self.assertEqual(len(got), 2)
        self.assertEqual(len(urls), 2)
        self.assertEqual(sleeps, [1.5])  # ページ間 1 回だけ
        header, rows = ef.pages_to_table(got)
        self.assertEqual(len(rows), 9)
        self.assertEqual(rows[-1][4:6], ["27000", "大阪府"])

    def test_stops_on_status_1(self):
        got = ef.fetch_all_pages("APP", "X", getter=lambda url: load(NODATA), sleep=lambda s: None)
        self.assertEqual(len(got), 1)

    def test_non_advancing_next_key_does_not_loop(self):
        page = load(PAGE1)
        page["GET_STATS_DATA"]["STATISTICAL_DATA"]["RESULT_INF"]["NEXT_KEY"] = 1
        calls = []
        got = ef.fetch_all_pages("APP", "X", getter=lambda url: calls.append(url) or page,
                                 sleep=lambda s: None)
        self.assertEqual(len(got), 1)
        self.assertEqual(len(calls), 1)


class RetryTest(unittest.TestCase):
    def test_retries_transient_errors_with_backoff(self):
        attempts, sleeps, logs = [], [], []

        def getter(url):
            attempts.append(url)
            if len(attempts) == 1:
                raise urllib.error.URLError("connection reset")
            if len(attempts) == 2:
                raise urllib.error.HTTPError(url, 503, "Service Unavailable", {}, None)
            return {"ok": True}

        got = ef.fetch_with_retry("http://x", getter=getter, retries=3, backoff=2.0,
                                  sleep=sleeps.append, log=logs.append)
        self.assertEqual(got, {"ok": True})
        self.assertEqual(sleeps, [2.0, 4.0])
        self.assertEqual(len(logs), 2)

    def test_non_retryable_http_error_raises_immediately(self):
        def getter(url):
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

        with self.assertRaises(urllib.error.HTTPError):
            ef.fetch_with_retry("http://x", getter=getter, retries=3, sleep=lambda s: None)

    def test_gives_up_after_retries(self):
        def getter(url):
            raise urllib.error.URLError("down")

        sleeps = []
        with self.assertRaises(ef.EstatError):
            ef.fetch_with_retry("http://x", getter=getter, retries=2, sleep=sleeps.append)
        self.assertEqual(len(sleeps), 2)


class CliTest(unittest.TestCase):
    def test_from_file_writes_csv_with_bom_and_header(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.csv")
            rc = ef.main(["--stats-data-id", "0003410379", "--from-file",
                          os.path.join(FIXTURES, PAGE1), os.path.join(FIXTURES, PAGE2),
                          "--out", out, "--quiet"])
            self.assertEqual(rc, 0)
            with open(out, "rb") as fh:
                raw = fh.read()
            self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))  # utf-8-sig
            lines = raw.decode("utf-8-sig").splitlines()
            self.assertEqual(len(lines), 10)  # header + 9 rows
            self.assertTrue(lines[0].startswith("表章項目コード,表章項目,"))

    def test_error_fixture_returns_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                rc = ef.main(["--stats-data-id", "X", "--from-file", os.path.join(FIXTURES, ERROR),
                              "--out", os.path.join(tmp, "o.csv"), "--quiet"])
            self.assertEqual(rc, 1)
            self.assertIn("STATUS=100", err.getvalue())

    def test_missing_app_id_is_usage_error(self):
        env_backup = os.environ.pop("ESTAT_APP_ID", None)
        try:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
                ef.main(["--stats-data-id", "X", "--out", os.devnull, "--quiet"])
            self.assertEqual(ctx.exception.code, 2)
        finally:
            if env_backup is not None:
                os.environ["ESTAT_APP_ID"] = env_backup


if __name__ == "__main__":
    unittest.main()
