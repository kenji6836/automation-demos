# -*- coding: utf-8 -*-
"""ネットワーク不使用の unittest。API 応答は tests/fixtures のフィクスチャで差し替える。

実行: python3 -m unittest discover -s tests -v   （リポジトリの inquiry-reply-assistant/ で）
"""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error
from email.message import Message
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")
sys.path.insert(0, ROOT)

import reply_assistant as ra  # noqa: E402


def fixture(name):
    with open(os.path.join(FIXTURES, name), "r", encoding="utf-8") as f:
        return f.read()


class FakeResponse(object):
    """urlopen の戻り値の代替（with 文と read() だけ）。"""

    def __init__(self, text):
        self._data = text.encode("utf-8")

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(status, body_text, retry_after=None):
    headers = Message()
    if retry_after is not None:
        headers["retry-after"] = str(retry_after)
    return urllib.error.HTTPError("https://api.anthropic.com/v1/messages", status, "err", headers,
                                  io.BytesIO(body_text.encode("utf-8")))


class PromptTests(unittest.TestCase):
    def test_render_template_substitutes_all(self):
        out = ra.render_template("A=$a B=${b} 100%", {"a": 1, "b": "x"})
        self.assertEqual(out, "A=1 B=x 100%")

    def test_render_template_reports_missing(self):
        with self.assertRaises(ValueError) as cm:
            ra.render_template("Hello $company_name / $missing", {"company_name": "X"})
        self.assertIn("missing", str(cm.exception))

    def test_dollar_in_inquiry_body_is_passed_through(self):
        # 問い合わせ本文に $budget_code のような文字列があっても未設定扱いにしない（fresh-eyes 指摘）
        cfg = ra.load_config(None)
        _, user_prompt = ra.build_prompts(cfg, "予算コードは $budget_code と ${dept} です。$$ も。")
        self.assertIn("$budget_code と ${dept} です。$$ も。", user_prompt)
        self.assertEqual(ra.template_placeholders("a $x b ${y} c $$ d $x"), ["x", "y"])

    def test_build_prompts_uses_config_and_inquiry(self):
        cfg = ra.load_config(os.path.join(ROOT, "config.json"))
        cfg["company_name"] = "テスト株式会社"
        system_prompt, user_prompt = ra.build_prompts(cfg, "本文です")
        self.assertIn("テスト株式会社", system_prompt)
        self.assertIn(cfg["signature_placeholder"], system_prompt)
        self.assertNotIn("$company_name", system_prompt)
        self.assertIn("<inquiry>\n本文です\n</inquiry>", user_prompt)

    def test_load_config_defaults_and_override(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "c.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"company_name": "上書き社", "model": "claude-sonnet-5"}, f)
            cfg = ra.load_config(path)
        self.assertEqual(cfg["company_name"], "上書き社")
        self.assertEqual(cfg["model"], "claude-sonnet-5")
        self.assertEqual(cfg["signature_placeholder"], "[[署名]]")  # 既定値が残る

    def test_extract_subject(self):
        self.assertEqual(ra.extract_subject("From: a\nSubject: 件名テスト\n\n本文 Subject: x"), "件名テスト")
        self.assertEqual(ra.extract_subject("件名: 日本語ヘッダ\n\n本文"), "日本語ヘッダ")
        self.assertEqual(ra.extract_subject("ヘッダなしの本文\nSubject: 本文中"), "")


class ApiKeyTests(unittest.TestCase):
    def test_env_wins_over_keychain(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-env"}):
            with mock.patch.object(ra.subprocess, "run", side_effect=AssertionError("must not call security")):
                self.assertEqual(ra.resolve_api_key("apiguard.X"), "sk-env")

    def test_keychain_read_in_process_without_printing(self):
        done = mock.Mock(returncode=0, stdout="sk-keychain\n")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ANTHROPIC_API_KEY", None)
            with mock.patch.object(ra.subprocess, "run", return_value=done) as m:
                self.assertEqual(ra.resolve_api_key("apiguard.X"), "sk-keychain")
        argv = m.call_args[0][0]
        self.assertEqual(argv[:2], ["/usr/bin/security", "find-generic-password"])
        self.assertIn("apiguard.X", argv)
        self.assertTrue(m.call_args[1].get("capture_output"))

    def test_keychain_missing_or_unavailable(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ANTHROPIC_API_KEY", None)
            with mock.patch.object(ra.subprocess, "run", return_value=mock.Mock(returncode=44, stdout="")):
                self.assertIsNone(ra.resolve_api_key("apiguard.X"))
            with mock.patch.object(ra.subprocess, "run", side_effect=OSError("no security binary")):
                self.assertIsNone(ra.resolve_api_key("apiguard.X"))
            self.assertIsNone(ra.resolve_api_key(None))


class RequestBodyTests(unittest.TestCase):
    def test_body_shape(self):
        cfg = ra.load_config(None)
        body = ra.build_request_body(cfg, "SYS", "USER")
        self.assertEqual(body["model"], ra.DEFAULT_MODEL)
        self.assertEqual(body["system"], "SYS")
        self.assertEqual(body["messages"], [{"role": "user", "content": "USER"}])
        self.assertEqual(body["output_config"]["format"]["type"], "json_schema")
        self.assertFalse(body["output_config"]["format"]["schema"]["additionalProperties"])

    def test_model_override_precedence(self):
        cfg = ra.load_config(None)
        cfg["model"] = "claude-sonnet-5"
        self.assertEqual(ra.build_request_body(cfg, "s", "u")["model"], "claude-sonnet-5")
        self.assertEqual(ra.build_request_body(cfg, "s", "u", model="claude-opus-5")["model"], "claude-opus-5")


class ParseResponseTests(unittest.TestCase):
    def test_ok(self):
        parsed = ra.parse_response(json.loads(fixture("response_ok.json")))
        self.assertEqual(parsed["category"], "見積依頼")
        self.assertEqual(parsed["urgency"], "中")
        self.assertEqual(len(parsed["summary"]), 3)
        self.assertTrue(parsed["reply_draft"].endswith("[[署名]]"))

    def test_normalizes_bad_values(self):
        parsed = ra.parse_response(json.loads(fixture("response_bad_values.json")))
        self.assertEqual(parsed["summary"], ["1行目", "2行目", ""])  # 文字列→3要素に正規化
        self.assertEqual(parsed["category"], "その他")  # 未知の分類はその他
        self.assertEqual(parsed["urgency"], "中")  # 未知の緊急度は中

    def test_refusal_and_max_tokens(self):
        with self.assertRaises(ra.ApiError):
            ra.parse_response({"stop_reason": "refusal", "content": []})
        with self.assertRaises(ra.ApiError) as cm:
            ra.parse_response({"stop_reason": "max_tokens", "content": [{"type": "text", "text": "{"}]})
        self.assertIn("max_tokens", str(cm.exception))

    def test_invalid_json_and_missing_keys(self):
        with self.assertRaises(ra.ApiError):
            ra.parse_response({"stop_reason": "end_turn", "content": [{"type": "text", "text": "not json"}]})
        with self.assertRaises(ra.ApiError) as cm:
            ra.parse_response({"stop_reason": "end_turn", "content": [{"type": "text", "text": "{\"summary\": []}"}]})
        self.assertIn("category", str(cm.exception))
        with self.assertRaises(ra.ApiError):
            ra.parse_response({"stop_reason": "end_turn", "content": []})

    def test_usage_and_cost(self):
        usage = ra.extract_usage(json.loads(fixture("response_ok.json")))
        self.assertEqual(usage["input_tokens"], 1200)
        self.assertEqual(usage["output_tokens"], 400)
        cost = ra.estimate_cost_usd("claude-haiku-4-5", usage)
        self.assertAlmostEqual(cost, (1200 * 1.0 + 400 * 5.0) / 1_000_000)
        self.assertIsNone(ra.estimate_cost_usd("unknown-model", usage))
        # 応答の model は日付付き ID で返る（実測 2026-09-08）→ 前方一致で価格表を引く
        self.assertAlmostEqual(ra.estimate_cost_usd("claude-haiku-4-5-20251001", usage), cost)
        self.assertIsNone(ra.estimate_cost_usd("claude-haiku-4", usage))
        self.assertIsNone(ra.estimate_cost_usd("claude-haiku-4-55", usage))
        self.assertEqual(ra.extract_usage({})["input_tokens"], 0)


class ApiCallTests(unittest.TestCase):
    def setUp(self):
        self.body = {"model": "claude-haiku-4-5", "max_tokens": 10, "messages": []}
        self.sleeps = []
        self.sleep_patch = mock.patch.object(ra, "_sleep", side_effect=self.sleeps.append)
        self.sleep_patch.start()
        self.addCleanup(self.sleep_patch.stop)

    def test_success_sends_headers_and_body(self):
        seen = {}

        def fake_urlopen(req, timeout):
            seen["url"] = req.full_url
            seen["headers"] = {k.lower(): v for k, v in req.header_items()}
            seen["body"] = json.loads(req.data.decode("utf-8"))
            return FakeResponse(fixture("response_ok.json"))

        with mock.patch.object(ra, "_urlopen", side_effect=fake_urlopen):
            resp = ra.call_messages_api(self.body, "sk-test")
        self.assertEqual(resp["stop_reason"], "end_turn")
        self.assertEqual(seen["url"], ra.API_URL)
        self.assertEqual(seen["headers"]["x-api-key"], "sk-test")
        self.assertEqual(seen["headers"]["anthropic-version"], ra.API_VERSION)
        self.assertEqual(seen["body"]["model"], "claude-haiku-4-5")
        self.assertEqual(self.sleeps, [])

    def test_retries_on_529_then_succeeds(self):
        calls = [http_error(529, fixture("error_529.json")), FakeResponse(fixture("response_ok.json"))]
        with mock.patch.object(ra, "_urlopen", side_effect=calls) as m:
            resp = ra.call_messages_api(self.body, "sk-test")
        self.assertEqual(resp["model"], "claude-haiku-4-5")
        self.assertEqual(m.call_count, 2)
        self.assertEqual(self.sleeps, [2.0])

    def test_retry_honours_retry_after_and_gives_up(self):
        errors = [http_error(429, "{}", retry_after=7) for _ in range(ra.MAX_ATTEMPTS)]
        with mock.patch.object(ra, "_urlopen", side_effect=errors) as m:
            with self.assertRaises(ra.ApiError) as cm:
                ra.call_messages_api(self.body, "sk-test")
        self.assertEqual(m.call_count, ra.MAX_ATTEMPTS)
        self.assertEqual(self.sleeps, [7.0] * (ra.MAX_ATTEMPTS - 1))
        self.assertTrue(cm.exception.retryable)
        self.assertEqual(cm.exception.status, 429)

    def test_no_retry_on_401(self):
        with mock.patch.object(ra, "_urlopen", side_effect=http_error(401, fixture("error_401.json"))) as m:
            with self.assertRaises(ra.ApiError) as cm:
                ra.call_messages_api(self.body, "bad")
        self.assertEqual(m.call_count, 1)
        self.assertEqual(cm.exception.status, 401)
        self.assertFalse(cm.exception.retryable)
        self.assertIn("authentication_error", str(cm.exception))

    def test_connection_error_is_retried(self):
        calls = [urllib.error.URLError("timed out"), FakeResponse(fixture("response_ok.json"))]
        with mock.patch.object(ra, "_urlopen", side_effect=calls) as m:
            ra.call_messages_api(self.body, "sk-test")
        self.assertEqual(m.call_count, 2)

    def test_non_json_response(self):
        with mock.patch.object(ra, "_urlopen", return_value=FakeResponse("<html>oops</html>")):
            with self.assertRaises(ra.ApiError):
                ra.call_messages_api(self.body, "sk-test")


class EndToEndTests(unittest.TestCase):
    """main() をフィクスチャ応答で通し、ファイル出力と集計を確認する。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.out = os.path.join(self.tmp, "drafts")
        self.inputs = [os.path.join(ROOT, "inquiries", n) for n in ("01_estimate.txt", "02_bug_report.txt")]
        mock.patch.object(ra, "_sleep", lambda s: None).start()
        self.addCleanup(mock.patch.stopall)

    def run_main(self, argv, env=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env or {}, clear=False), \
                mock.patch.object(sys, "stdout", stdout), mock.patch.object(sys, "stderr", stderr):
            if env is not None and "ANTHROPIC_API_KEY" not in env:
                os.environ.pop("ANTHROPIC_API_KEY", None)
            code = ra.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_writes_json_md_and_usage(self):
        with mock.patch.object(ra, "_urlopen", return_value=FakeResponse(fixture("response_ok.json"))) as m:
            code, out, err = self.run_main(["--in"] + self.inputs + ["--out", self.out, "--jpy-rate", "100"],
                                           env={"ANTHROPIC_API_KEY": "sk-test"})
        self.assertEqual(code, 0, err)
        self.assertEqual(m.call_count, 2)
        for name in ("01_estimate", "02_bug_report"):
            with open(os.path.join(self.out, name + ".json"), encoding="utf-8") as f:
                data = json.load(f)
            self.assertEqual(data["category"], "見積依頼")
            self.assertEqual(data["usage"]["input_tokens"], 1200)
            self.assertAlmostEqual(data["cost_usd"], 0.0032)
            with open(os.path.join(self.out, name + ".md"), encoding="utf-8") as f:
                md = f.read()
            self.assertIn("## 要約", md)
            self.assertIn("[[署名]]", md)
            self.assertIn("送信前に必ず人が確認", md)
        self.assertIn("業務システムの改修見積について", open(os.path.join(self.out, "01_estimate.md"), encoding="utf-8").read())
        with open(os.path.join(self.out, "_usage.json"), encoding="utf-8") as f:
            usage = json.load(f)
        self.assertEqual(usage["api_calls"], 2)
        self.assertEqual(usage["usage"]["input_tokens"], 2400)
        self.assertAlmostEqual(usage["cost_usd"], 0.0064)
        self.assertAlmostEqual(usage["cost_jpy"], 0.64)
        self.assertIn("2 通成功", out)

    def test_partial_failure_returns_1_and_continues(self):
        calls = [http_error(400, "{\"error\": {\"type\": \"invalid_request_error\", \"message\": \"bad\"}}"),
                 FakeResponse(fixture("response_ok.json"))]
        with mock.patch.object(ra, "_urlopen", side_effect=calls) as m:
            code, out, err = self.run_main(["--in"] + self.inputs + ["--out", self.out],
                                           env={"ANTHROPIC_API_KEY": "sk-test"})
        self.assertEqual(code, 1)
        self.assertEqual(m.call_count, 2)
        self.assertIn("[NG]", err)
        self.assertIn("invalid_request_error", err)
        self.assertFalse(os.path.exists(os.path.join(self.out, "01_estimate.json")))
        self.assertTrue(os.path.exists(os.path.join(self.out, "02_bug_report.json")))

    def test_truncated_response_still_counts_usage(self):
        # max_tokens 打ち切りで解釈に失敗しても、課金されたトークンは _usage.json に集計される（R3 指摘）
        truncated = json.dumps({"model": "claude-haiku-4-5", "stop_reason": "max_tokens",
                                "content": [{"type": "text", "text": "{\"summary\": ["}],
                                "usage": {"input_tokens": 1200, "output_tokens": 2048}})
        with mock.patch.object(ra, "_urlopen", return_value=FakeResponse(truncated)):
            code, out, err = self.run_main(["--in", self.inputs[0], "--out", self.out],
                                           env={"ANTHROPIC_API_KEY": "sk-test"})
        self.assertEqual(code, 1)
        self.assertIn("max_tokens", err)
        with open(os.path.join(self.out, "_usage.json"), encoding="utf-8") as f:
            usage = json.load(f)
        self.assertEqual(usage["files_ok"], 0)
        self.assertEqual(usage["usage"]["output_tokens"], 2048)
        self.assertAlmostEqual(usage["cost_usd"], (1200 * 1.0 + 2048 * 5.0) / 1_000_000)

    def test_auth_error_aborts_remaining(self):
        with mock.patch.object(ra, "_urlopen", side_effect=http_error(401, fixture("error_401.json"))) as m:
            code, out, err = self.run_main(["--in"] + self.inputs + ["--out", self.out],
                                           env={"ANTHROPIC_API_KEY": "sk-bad"})
        self.assertEqual(code, 1)
        self.assertEqual(m.call_count, 1)  # 2 通目は呼ばない
        self.assertIn("認証エラー", err)
        self.assertFalse(os.path.exists(self.out))

    def test_missing_api_key_exits_2_without_network(self):
        with mock.patch.object(ra, "_urlopen", side_effect=AssertionError("network must not be used")):
            code, out, err = self.run_main(["--in"] + self.inputs + ["--out", self.out], env={})
        self.assertEqual(code, 2)
        self.assertIn("ANTHROPIC_API_KEY", err)
        # --keychain 指定で未登録のときも 2 で終了し、サービス名を案内する（値は出ない）
        with mock.patch.object(ra.subprocess, "run", return_value=mock.Mock(returncode=44, stdout="")):
            code, out, err = self.run_main(["--in"] + self.inputs + ["--out", self.out, "--keychain", "apiguard.NOPE"], env={})
        self.assertEqual(code, 2)
        self.assertIn("apiguard.NOPE", err)

    def test_dry_run_prints_prompts_without_network(self):
        with mock.patch.object(ra, "_urlopen", side_effect=AssertionError("network must not be used")):
            code, out, err = self.run_main(["--in", self.inputs[0], "--out", self.out, "--dry-run",
                                            "--model", "claude-sonnet-5"], env={})
        self.assertEqual(code, 0)
        self.assertIn("model=claude-sonnet-5", out)
        self.assertIn("サンプル株式会社", out)
        self.assertIn("<inquiry>", out)
        self.assertFalse(os.path.exists(self.out))

    def test_dry_run_with_dollar_in_body_does_not_crash(self):
        path = os.path.join(self.tmp, "dollar.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write("Subject: 件名\n\n本文に $price と ${code} を含む\n")
        code, out, err = self.run_main(["--in", path, "--out", self.out, "--dry-run"], env={})
        self.assertEqual(code, 0, err)
        self.assertIn("$price と ${code}", out)

    def test_dry_run_missing_input_exits_2(self):
        code, out, err = self.run_main(["--in", os.path.join(self.tmp, "nope.txt"), "--out", self.out, "--dry-run"], env={})
        self.assertEqual(code, 2)
        self.assertIn("[NG]", err)

    def test_refuses_to_overwrite_input_files(self):
        # --out が入力と同じディレクトリで、入力が .md/.json のとき上書きを拒否する（R3 指摘）
        src_dir = os.path.join(self.tmp, "inbox")
        os.makedirs(src_dir)
        src = os.path.join(src_dir, "customer.md")
        with open(src, "w", encoding="utf-8") as f:
            f.write("Subject: x\n\n本文\n")
        with mock.patch.object(ra, "_urlopen", side_effect=AssertionError("network must not be used")):
            code, out, err = self.run_main(["--in", src, "--out", src_dir], env={"ANTHROPIC_API_KEY": "sk-test"})
        self.assertEqual(code, 2)
        self.assertIn("上書き", err)
        self.assertEqual(open(src, encoding="utf-8").read(), "Subject: x\n\n本文\n")

    def test_refuses_duplicate_output_names(self):
        a = os.path.join(self.tmp, "a", "same.txt")
        b = os.path.join(self.tmp, "b", "same.txt")
        for path in (a, b):
            os.makedirs(os.path.dirname(path))
            with open(path, "w", encoding="utf-8") as f:
                f.write("本文\n")
        with mock.patch.object(ra, "_urlopen", side_effect=AssertionError("network must not be used")):
            code, out, err = self.run_main(["--in", a, b, "--out", self.out], env={"ANTHROPIC_API_KEY": "sk-test"})
        self.assertEqual(code, 2)
        self.assertIn("衝突", err)
        # 同じファイルを2回指定しただけなら衝突ではない
        ra.check_output_collisions([a, a], self.out)
        # 集計ファイル _usage.json と同名になる入力は拒否
        with self.assertRaises(ValueError):
            ra.check_output_collisions([os.path.join(self.tmp, "_usage.txt")], self.out)
        # 出力先の _usage.json が入力へのシンボリックリンクでも realpath で検出して拒否
        os.makedirs(self.out)
        os.symlink(a, os.path.join(self.out, "_usage.json"))
        with self.assertRaises(ValueError):
            ra.check_output_collisions([a], self.out)

    def test_invalid_json_error_does_not_include_model_text(self):
        with self.assertRaises(ra.ApiError) as cm:
            ra.parse_response({"stop_reason": "end_turn", "content": [{"type": "text", "text": "顧客の秘密 not json"}]})
        self.assertNotIn("顧客の秘密", str(cm.exception))

    def test_broken_config_exits_1(self):
        bad = os.path.join(self.tmp, "bad.json")
        with open(bad, "w", encoding="utf-8") as f:
            f.write("[1, 2]")
        code, out, err = self.run_main(["--in", self.inputs[0], "--out", self.out, "--config", bad],
                                       env={"ANTHROPIC_API_KEY": "sk-test"})
        self.assertEqual(code, 1)
        self.assertIn("設定の読み込みに失敗", err)

    def test_missing_explicit_config_exits_1_without_fallback(self):
        # --config を明示したのにパスが無い場合は既定設定に黙って戻さず、エラー終了する（R2 指摘）
        missing = os.path.join(self.tmp, "nope.json")
        with mock.patch.object(ra, "_urlopen", side_effect=AssertionError("network must not be used")):
            code, out, err = self.run_main(["--in", self.inputs[0], "--out", self.out, "--config", missing],
                                           env={"ANTHROPIC_API_KEY": "sk-test"})
        self.assertEqual(code, 1)
        self.assertIn("nope.json", err)
        self.assertFalse(os.path.exists(self.out))


if __name__ == "__main__":
    unittest.main()
