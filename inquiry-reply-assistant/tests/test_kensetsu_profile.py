# -*- coding: utf-8 -*-
"""建設プロファイルの unittest。API 応答は既存フィクスチャで差し替える。"""
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from email.parser import Parser
from email.utils import getaddresses
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")
PROFILE = os.path.join(ROOT, "profiles", "kensetsu")
PROMPTS = os.path.join(PROFILE, "prompts")
INQUIRIES = os.path.join(ROOT, "inquiries", "kensetsu")
ARTIFACTS = os.path.join(os.path.dirname(ROOT), ".dd")
SAMPLE_NAMES = [
    "01_reform_estimate.txt",
    "02_gaikou_estimate.txt",
    "03_shinchiku_soudan.txt",
    "04_koji_renraku.txt",
    "05_shizai_eigyo.txt",
]
sys.path.insert(0, ROOT)

import reply_assistant as ra  # noqa: E402


def response_with_category(category):
    with open(os.path.join(FIXTURES, "response_ok.json"), encoding="utf-8") as f:
        response = json.load(f)
    data = json.loads(response["content"][0]["text"])
    data["category"] = category
    response["content"][0]["text"] = json.dumps(data, ensure_ascii=False)
    return response


class KensetsuProfileTests(unittest.TestCase):
    def setUp(self):
        self.cfg = ra.load_config(os.path.join(PROFILE, "config.json"))
        self.inputs = sorted(glob.glob(os.path.join(INQUIRIES, "*.txt")))

    def test_profile_config(self):
        default = ra.load_config(os.path.join(ROOT, "config.json"))
        self.assertEqual(self.cfg["company_name"], "サンプル工務店")
        self.assertEqual(self.cfg["department"], "見積・お客様窓口")
        self.assertEqual(self.cfg["categories"], ["見積依頼", "施工中の連絡", "その他"])
        for name in ("tone", "model", "max_tokens", "signature_placeholder"):
            self.assertEqual(self.cfg[name], default[name])

    def test_build_prompts_for_all_five_inquiries(self):
        self.assertEqual(len(self.inputs), 5)
        self.assertEqual(
            ra.template_placeholders(ra.load_prompt("system.txt", PROMPTS)),
            ["company_name", "department", "signature_placeholder", "tone"],
        )
        for path in self.inputs:
            with self.subTest(path=os.path.basename(path)):
                inquiry = ra.read_inquiry(path)
                system, user = ra.build_prompts(self.cfg, inquiry["text"], PROMPTS)
                for word in ("見積依頼", "施工中の連絡", "その他", "現地確認",
                             "概算は現地確認後にお伝えする", "施工場所", "希望時期",
                             "おおよその予算", "図面/写真の有無", "ご連絡の取りやすい時間帯",
                             "箇条書き", "金額の断定", "工期の確約"):
                    self.assertIn(word, system)
                for name in ("company_name", "department", "tone", "signature_placeholder"):
                    self.assertIn(self.cfg[name], system)
                self.assertIn("<inquiry>\n" + inquiry["text"] + "\n</inquiry>", user)

    def test_inquiry_headers_body_length_and_example_domains(self):
        self.assertEqual([os.path.basename(path) for path in self.inputs], SAMPLE_NAMES)
        for path in self.inputs:
            with self.subTest(path=os.path.basename(path)):
                text = ra.read_inquiry(path)["text"]
                message = Parser().parsestr(text)
                for header in ("From", "Subject", "Date", "To"):
                    self.assertTrue(message.get(header), header)
                body = text.split("\n\n", 1)[1]
                self.assertGreaterEqual(len(body.splitlines()), 8)
                self.assertLessEqual(len(body.splitlines()), 15)
                for header in ("From", "To"):
                    addresses = getaddresses(message.get_all(header))
                    self.assertTrue(addresses)
                    for _, address in addresses:
                        self.assertRegex(address, r"^[^@\s]+@example\.[a-z]+$")
                self.assertTrue(re.findall(r"[\w.+-]+@[\w.-]+", body))
                for address in re.findall(r"[\w.+-]+@[\w.-]+", text):
                    self.assertRegex(address, r"^[^@\s]+@example\.[a-z]+$")

    def test_cli_dry_run_for_all_five_inquiries(self):
        os.makedirs(ARTIFACTS, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="kensetsu-", dir=ARTIFACTS) as tmp:
            out = os.path.join(tmp, "drafts")
            command = [sys.executable, "reply_assistant.py", "--in"]
            command += [os.path.relpath(path, ROOT) for path in self.inputs]
            command += ["--out", out, "--config", "profiles/kensetsu/config.json",
                        "--prompts", "profiles/kensetsu/prompts", "--dry-run"]
            done = subprocess.run(
                command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30,
                env={"PATH": os.defpath, "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"},
            )
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stdout.count("[dry-run]"), 5)
            self.assertEqual(done.stderr, "")
            for name in SAMPLE_NAMES:
                self.assertIn(name, done.stdout)
            self.assertIn("サンプル工務店", done.stdout)
            self.assertFalse(os.path.exists(out))


class ConfiguredCategoryTests(unittest.TestCase):
    def setUp(self):
        self.cfg = ra.load_config(os.path.join(PROFILE, "config.json"))

    def test_configured_category_survives_normalization(self):
        parsed = ra.parse_response(response_with_category("施工中の連絡"), self.cfg)
        self.assertEqual(parsed["category"], "施工中の連絡")

    def test_without_categories_keeps_legacy_normalization(self):
        response = response_with_category("施工中の連絡")
        self.assertEqual(ra.parse_response(response)["category"], "その他")
        for cfg in (ra.load_config(None), ra.load_config(os.path.join(ROOT, "config.json"))):
            with self.subTest(cfg=cfg):
                self.assertEqual(ra.parse_response(response, cfg)["category"], "その他")
                self.assertEqual(ra.parse_response(response_with_category("不具合"), cfg)["category"], "不具合")

    def test_schema_uses_profile_without_changing_defaults(self):
        configured = ra.build_request_body(self.cfg, "system", "user")
        default = ra.build_request_body(ra.load_config(None), "system", "user")
        configured_schema = configured["output_config"]["format"]["schema"]
        default_schema = default["output_config"]["format"]["schema"]
        self.assertEqual(configured_schema["properties"]["category"]["enum"], self.cfg["categories"])
        self.assertEqual(default_schema["properties"]["category"]["enum"], ["見積依頼", "不具合", "その他"])
        self.assertEqual(default_schema, ra.OUTPUT_SCHEMA)
        configured_schema["properties"]["category"]["enum"].append("追加分類")
        self.assertEqual(self.cfg["categories"], ["見積依頼", "施工中の連絡", "その他"])
        self.assertEqual(ra.CATEGORIES, ["見積依頼", "不具合", "その他"])
        self.assertEqual(ra.OUTPUT_SCHEMA["properties"]["category"]["enum"], ra.CATEGORIES)

    def test_invalid_category_settings_use_defaults(self):
        for categories in (None, [], "施工中の連絡", 1, {}, ["施工中の連絡", None], ["施工中の連絡", 1]):
            with self.subTest(categories=categories):
                cfg = dict(self.cfg, categories=categories)
                body = ra.build_request_body(cfg, "system", "user")
                self.assertEqual(body["output_config"]["format"]["schema"]["properties"]["category"]["enum"],
                                 ["見積依頼", "不具合", "その他"])
                self.assertEqual(ra.parse_response(response_with_category("施工中の連絡"), cfg)["category"], "その他")

    def test_unknown_category_uses_last_configured_value(self):
        for categories in (self.cfg["categories"], ["相談", "施工連絡", "要確認"], ["受付"]):
            with self.subTest(categories=categories):
                cfg = dict(self.cfg, categories=categories)
                parsed = ra.parse_response(response_with_category("未知の分類"), cfg)
                self.assertEqual(parsed["category"], categories[-1])

    def test_process_inquiry_passes_category_to_markdown(self):
        response = response_with_category("施工中の連絡")
        path = os.path.join(INQUIRIES, "04_koji_renraku.txt")
        with mock.patch.object(ra, "call_messages_api", return_value=response) as call:
            result = ra.process_inquiry(path, self.cfg, "", prompts_dir=PROMPTS)
        call.assert_called_once()
        schema = call.call_args[0][0]["output_config"]["format"]["schema"]
        self.assertEqual(schema["properties"]["category"]["enum"], self.cfg["categories"])
        self.assertEqual(result["category"], "施工中の連絡")
        self.assertIn("- 分類: **施工中の連絡**", ra.render_markdown(result))


if __name__ == "__main__":
    unittest.main()
