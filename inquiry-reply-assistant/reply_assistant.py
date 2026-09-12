#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
inquiry-reply-assistant — 問い合わせメール → 要約・分類・緊急度・返信下書き（Claude API）

依存ゼロ（Python 3.9+ 標準ライブラリのみ）。Messages API を urllib で直接呼ぶ。

使い方:
    ANTHROPIC_API_KEY=... python3 reply_assistant.py --in inquiries/*.txt --out drafts/
    python3 reply_assistant.py --in inquiries/*.txt --out drafts/ --dry-run   # API を呼ばずプロンプト確認
    python3 reply_assistant.py --keychain apiguard.ANTHROPIC_API_KEY --in ... --out ...   # macOS Keychain から読む

出力（--out 配下）:
    <name>.json   構造化結果 + usage + 概算費用
    <name>.md     人が読む用（要約・分類・緊急度・返信下書き）
    _usage.json   実行全体のトークン合計と概算費用
"""
import argparse
import copy
import datetime as _dt
import json
import os
import re
import string
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-haiku-4-5"
DEFAULT_MAX_TOKENS = 2048
REQUEST_TIMEOUT_SEC = 120
MAX_ATTEMPTS = 3
RETRYABLE_STATUS = {429, 500, 529}

# 価格（USD / 1M tokens）。出典: claude-api スキルの価格表（cached 2026-06-24）と
# https://platform.claude.com/docs/en/about-claude/pricing （ライブ確認 2026-09-08 JST・一致）
# キャッシュ未使用のため input/output のみで概算する。
PRICES_USD_PER_MTOK = {
    "claude-haiku-4-5": {"input": 1.00, "output": 5.00},
    "claude-sonnet-5": {"input": 2.00, "output": 10.00},
    "claude-opus-5": {"input": 5.00, "output": 25.00},
}
DEFAULT_JPY_PER_USD = 150.0  # 概算レート（要更新）

USAGE_STEM = "_usage"  # 集計ファイル名（drafts/_usage.json）

CATEGORIES = ["見積依頼", "不具合", "その他"]
URGENCIES = ["高", "中", "低"]

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "array",
            "items": {"type": "string"},
            "description": "問い合わせの要点。日本語で3行（配列要素3つ）",
        },
        "category": {"type": "string", "enum": CATEGORIES},
        "urgency": {"type": "string", "enum": URGENCIES},
        "urgency_reason": {"type": "string"},
        "reply_draft": {"type": "string"},
    },
    "required": ["summary", "category", "urgency", "urgency_reason", "reply_draft"],
    "additionalProperties": False,
}

HERE = os.path.dirname(os.path.abspath(__file__))


class ApiError(Exception):
    """API 呼び出しの失敗（HTTP エラー・接続エラー・応答不正）。"""

    def __init__(self, message: str, status: Optional[int] = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable
        self.usage: Optional[Dict[str, int]] = None  # 応答は届いたが解釈に失敗したときの課金トークン


# ---------------------------------------------------------------- 設定・プロンプト


def load_config(path: Optional[str]) -> Dict[str, Any]:
    cfg = {
        "company_name": "サンプル株式会社",
        "department": "カスタマーサポート",
        "tone": "丁寧で簡潔なビジネス日本語（です・ます調）",
        "signature_placeholder": "[[署名]]",
        "model": DEFAULT_MODEL,
        "max_tokens": DEFAULT_MAX_TOKENS,
    }
    if path:
        with open(path, "r", encoding="utf-8") as f:
            user_cfg = json.load(f)
        if not isinstance(user_cfg, dict):
            raise ValueError("config はオブジェクト（{...}）である必要があります: %s" % path)
        cfg.update(user_cfg)
    return cfg


def get_categories(cfg: Optional[Dict[str, Any]] = None) -> List[str]:
    """設定に非空の文字列配列があれば分類一覧に使い、なければ既定値を返す。"""
    categories = (cfg or {}).get("categories")
    if isinstance(categories, list) and categories and all(isinstance(c, str) for c in categories):
        return list(categories)
    return list(CATEGORIES)


def load_prompt(name: str, prompts_dir: Optional[str] = None) -> str:
    base = prompts_dir or os.path.join(HERE, "prompts")
    with open(os.path.join(base, name), "r", encoding="utf-8") as f:
        return f.read()


def template_placeholders(template: str) -> List[str]:
    """テンプレート側に書かれた `$name` / `${name}` の名前一覧（`$$` は除く）。"""
    names = set()
    for _, named, braced, _ in string.Template.pattern.findall(template):
        if named or braced:
            names.add(named or braced)
    return sorted(names)


def render_template(template: str, values: Dict[str, Any]) -> str:
    """`$name` 形式のプレースホルダを置換する（JSON の波括弧と衝突しないよう string.Template を使用）。

    未設定の判定はテンプレート側だけで行う。差し込む値（問い合わせ本文など）に `$xxx` が
    含まれていてもそのまま通す（safe_substitute は差し込んだ値を再走査しない）。
    """
    missing = [n for n in template_placeholders(template) if n not in values]
    if missing:
        raise ValueError("プロンプトに未設定のプレースホルダがあります: %s" % ", ".join(missing))
    return string.Template(template).safe_substitute({k: str(v) for k, v in values.items()})


def build_prompts(cfg: Dict[str, Any], inquiry_text: str, prompts_dir: Optional[str] = None):
    system_prompt = render_template(load_prompt("system.txt", prompts_dir), cfg)
    user_prompt = render_template(load_prompt("user.txt", prompts_dir), {"inquiry": inquiry_text})
    return system_prompt, user_prompt


# ---------------------------------------------------------------- 入力


def read_inquiry(path: str) -> Dict[str, str]:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    return {"path": path, "text": text, "subject": extract_subject(text)}


def extract_subject(text: str) -> str:
    """先頭のヘッダ行（Subject: ...／件名: ...）があれば件名を返す。なければ空文字。"""
    for line in text.splitlines():
        if not line.strip() or not re.match(r"^[^\s:：]{1,40}[:：]", line):
            break  # ヘッダ部（先頭の「キー: 値」行の連続）が終わったら探さない
        lower = line.lower()
        for prefix in ("subject:", "件名:", "件名："):
            if lower.startswith(prefix):
                return line[len(prefix):].strip()
    return ""


# ---------------------------------------------------------------- API 呼び出し


def _urlopen(req, timeout):  # テストで差し替えるための薄いラッパ
    return urllib.request.urlopen(req, timeout=timeout)


def _sleep(sec: float):  # テストで差し替え
    time.sleep(sec)


def read_keychain_secret(service: str) -> Optional[str]:
    """macOS Keychain のジェネリックパスワード（サービス名 service）をプロセス内で読む。

    値は戻り値としてのみ扱い、標準出力・ログ・例外メッセージには出さない。
    シェルで `security ... -w` を直接打つと履歴に値が残るため、この関数経由で読む。
    未登録・非 macOS なら None。
    """
    try:
        r = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", service, "-w"],
                           capture_output=True, text=True)
    except OSError:
        return None
    if r.returncode != 0:
        return None
    return r.stdout.strip() or None


def resolve_api_key(keychain_service: Optional[str] = None) -> Optional[str]:
    """環境変数 ANTHROPIC_API_KEY → （指定があれば）Keychain の順で API キーを解決する。"""
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if key:
        return key
    if keychain_service:
        return read_keychain_secret(keychain_service)
    return None


def build_request_body(cfg: Dict[str, Any], system_prompt: str, user_prompt: str, model: Optional[str] = None) -> Dict[str, Any]:
    schema = copy.deepcopy(OUTPUT_SCHEMA)
    schema["properties"]["category"]["enum"] = get_categories(cfg)
    return {
        "model": model or cfg.get("model") or DEFAULT_MODEL,
        "max_tokens": int(cfg.get("max_tokens") or DEFAULT_MAX_TOKENS),
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
        "output_config": {"format": {"type": "json_schema", "schema": schema}},
    }


def call_messages_api(body: Dict[str, Any], api_key: str) -> Dict[str, Any]:
    """Messages API を呼び、応答 JSON（dict）を返す。429/500/529・接続エラーは最大 MAX_ATTEMPTS 回リトライ。"""
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": API_VERSION,
    }
    last_err: Optional[ApiError] = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        req = urllib.request.Request(API_URL, data=data, headers=headers, method="POST")
        try:
            with _urlopen(req, REQUEST_TIMEOUT_SEC) as resp:
                raw = resp.read().decode("utf-8")
            try:
                return json.loads(raw)
            except ValueError:
                raise ApiError("応答が JSON ではありません: %s" % raw[:200])
        except urllib.error.HTTPError as e:
            status = e.code
            detail = _read_error_detail(e)
            retryable = status in RETRYABLE_STATUS
            last_err = ApiError("HTTP %d: %s" % (status, detail), status=status, retryable=retryable)
            if not retryable:
                raise last_err
            wait = _retry_wait(e.headers.get("retry-after") if e.headers else None, attempt)
        except urllib.error.URLError as e:
            last_err = ApiError("接続エラー: %s" % e.reason, retryable=True)
            wait = _retry_wait(None, attempt)
        if attempt < MAX_ATTEMPTS:
            sys.stderr.write("  [retry %d/%d] %s → %.0f 秒待機\n" % (attempt, MAX_ATTEMPTS, last_err, wait))
            _sleep(wait)
    if last_err is None:  # 到達しない想定（ループは必ず例外経由でここに来る）
        raise ApiError("リトライ上限に達しました")
    raise ApiError("リトライ上限に達しました: %s" % last_err, status=last_err.status, retryable=True)


def _read_error_detail(e: urllib.error.HTTPError) -> str:
    try:
        payload = json.loads(e.read().decode("utf-8"))
        err = payload.get("error", {})
        return ("%s - %s" % (err.get("type", "error"), err.get("message", ""))).strip(" -")
    except Exception:
        return e.reason or "unknown error"


def _retry_wait(retry_after: Optional[str], attempt: int) -> float:
    if retry_after:
        try:
            return min(float(retry_after), 60.0)
        except ValueError:
            pass
    return float(2 ** attempt)  # 2, 4, 8 秒


# ---------------------------------------------------------------- 応答の整形


def parse_response(resp: Dict[str, Any], cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Messages API の応答から構造化結果を取り出し、検証・正規化する。"""
    stop = resp.get("stop_reason")
    if stop == "refusal":
        raise ApiError("モデルが応答を拒否しました（stop_reason=refusal）")
    if stop == "max_tokens":
        raise ApiError("出力が max_tokens で打ち切られました。config の max_tokens を増やしてください")
    text = next((b.get("text") for b in resp.get("content", []) if b.get("type") == "text"), None)
    if text is None:
        raise ApiError("応答にテキストブロックがありません")
    try:
        data = json.loads(text)
    except ValueError:
        # 応答本文（顧客情報を含みうる）はエラーに載せない
        raise ApiError("応答テキストが JSON として解釈できません（長さ %d 文字）" % len(text))
    if not isinstance(data, dict):
        raise ApiError("応答 JSON がオブジェクトではありません")
    missing = [k for k in OUTPUT_SCHEMA["required"] if k not in data]
    if missing:
        raise ApiError("応答 JSON に必須項目がありません: %s" % ", ".join(missing))

    summary = data["summary"]
    if isinstance(summary, str):
        summary = [s for s in summary.splitlines() if s.strip()]
    summary = [str(s).strip() for s in summary if str(s).strip()][:3]
    while len(summary) < 3:
        summary.append("")

    categories = get_categories(cfg)
    category = str(data["category"]).strip()
    if category not in categories:
        category = categories[-1]
    urgency = str(data["urgency"]).strip()
    if urgency not in URGENCIES:
        urgency = "中"

    return {
        "summary": summary,
        "category": category,
        "urgency": urgency,
        "urgency_reason": str(data["urgency_reason"]).strip(),
        "reply_draft": str(data["reply_draft"]).strip(),
    }


def extract_usage(resp: Dict[str, Any]) -> Dict[str, int]:
    usage = resp.get("usage") or {}
    return {
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "cache_creation_input_tokens": int(usage.get("cache_creation_input_tokens") or 0),
        "cache_read_input_tokens": int(usage.get("cache_read_input_tokens") or 0),
    }


def lookup_price(model: str) -> Optional[Dict[str, float]]:
    """価格表を引く。応答の model はエイリアスでなく日付付き ID（例: claude-haiku-4-5-20251001）で
    返ることがあるため、前方一致（最長一致）で解決する。"""
    if model in PRICES_USD_PER_MTOK:
        return PRICES_USD_PER_MTOK[model]
    candidates = [k for k in PRICES_USD_PER_MTOK if model.startswith(k + "-")]
    if not candidates:
        return None
    return PRICES_USD_PER_MTOK[max(candidates, key=len)]


def estimate_cost_usd(model: str, usage: Dict[str, int]) -> Optional[float]:
    price = lookup_price(model)
    if not price:
        return None
    return (usage["input_tokens"] * price["input"] + usage["output_tokens"] * price["output"]) / 1_000_000


# ---------------------------------------------------------------- 出力


def render_markdown(result: Dict[str, Any]) -> str:
    title = result.get("subject") or os.path.basename(result["source"])
    usage = result["usage"]
    cost = result.get("cost_usd")
    cost_text = "$%.5f" % cost if cost is not None else "不明（価格表にないモデル）"
    lines = [
        "# 返信下書き: %s" % title,
        "",
        "- 元ファイル: `%s`" % result["source"],
        "- 分類: **%s**" % result["category"],
        "- 緊急度: **%s** — %s" % (result["urgency"], result["urgency_reason"]),
        "- モデル: `%s`（入力 %d tok / 出力 %d tok / 概算 %s）"
        % (result["model"], usage["input_tokens"], usage["output_tokens"], cost_text),
        "",
        "## 要約",
        "",
    ]
    lines += ["%d. %s" % (i + 1, s) for i, s in enumerate(result["summary"])]
    lines += [
        "",
        "## 返信下書き（送信前に必ず人が確認・修正してください）",
        "",
        result["reply_draft"],
        "",
    ]
    return "\n".join(lines)


def output_paths(source: str, out_dir: str) -> Dict[str, str]:
    stem = os.path.splitext(os.path.basename(source))[0]
    return {"json": os.path.join(out_dir, stem + ".json"), "md": os.path.join(out_dir, stem + ".md")}


def check_output_collisions(inputs: List[str], out_dir: str) -> None:
    """出力先が入力ファイルを上書きしない・入力同士で出力名が衝突しないことを書き込み前に確認する。"""
    input_set = {os.path.realpath(p) for p in inputs}
    usage_path = os.path.join(out_dir, USAGE_STEM + ".json")
    if os.path.realpath(usage_path) in input_set:  # シンボリックリンク経由の上書きも realpath で検出
        raise ValueError("集計ファイル %s が入力ファイルを上書きします。--out を別のディレクトリにしてください" % usage_path)
    seen: Dict[str, str] = {}
    for path in inputs:
        paths = output_paths(path, out_dir)
        for out_path in paths.values():
            if os.path.realpath(out_path) in input_set:
                raise ValueError("出力先 %s が入力ファイルを上書きします。--out を別のディレクトリにしてください" % out_path)
        stem = os.path.splitext(os.path.basename(path))[0]
        if stem == USAGE_STEM:
            raise ValueError("入力 %s は集計ファイル %s.json と出力名が衝突します。ファイル名を変えてください" % (path, USAGE_STEM))
        if stem in seen and os.path.realpath(seen[stem]) != os.path.realpath(path):
            raise ValueError("入力 %s と %s は出力ファイル名（%s.json/.md）が衝突します" % (seen[stem], path, stem))
        seen[stem] = path


def write_outputs(result: Dict[str, Any], out_dir: str) -> Dict[str, str]:
    os.makedirs(out_dir, exist_ok=True)
    paths = output_paths(result["source"], out_dir)
    json_path, md_path = paths["json"], paths["md"]
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
        f.write("\n")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(render_markdown(result))
    return {"json": json_path, "md": md_path}


# ---------------------------------------------------------------- 1 通の処理


def process_inquiry(path: str, cfg: Dict[str, Any], api_key: str, model: Optional[str] = None,
                    prompts_dir: Optional[str] = None) -> Dict[str, Any]:
    inquiry = read_inquiry(path)
    system_prompt, user_prompt = build_prompts(cfg, inquiry["text"], prompts_dir)
    body = build_request_body(cfg, system_prompt, user_prompt, model)
    resp = call_messages_api(body, api_key)
    usage = extract_usage(resp)  # 解釈に失敗しても課金は発生しているので先に取り出す
    try:
        parsed = parse_response(resp, cfg)
    except ApiError as e:
        e.usage = usage
        raise
    used_model = resp.get("model") or body["model"]
    result = {
        "source": path,
        "subject": inquiry["subject"],
        "model": used_model,
        "generated_at": _dt.datetime.now(_dt.timezone.utc).astimezone().isoformat(timespec="seconds"),
    }
    result.update(parsed)
    result["usage"] = usage
    result["cost_usd"] = estimate_cost_usd(used_model, usage)
    return result


# ---------------------------------------------------------------- CLI


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="問い合わせメール → 要約・分類・緊急度・返信下書き（Claude API）")
    p.add_argument("--in", dest="inputs", nargs="+", required=True, metavar="FILE",
                   help="問い合わせテキスト（複数可。シェルのグロブ展開 inquiries/*.txt を想定）")
    p.add_argument("--out", dest="out_dir", required=True, metavar="DIR", help="出力先ディレクトリ")
    p.add_argument("--config", default=None,
                   help="会社名・口調などの設定 JSON（既定: 同梱 config.json。無ければ組み込みの既定値）")
    p.add_argument("--prompts", dest="prompts_dir", default=None, help="プロンプトのディレクトリ（既定: 同梱 prompts/）")
    p.add_argument("--model", default=None, help="モデル ID の上書き（既定: config.model → %s）" % DEFAULT_MODEL)
    p.add_argument("--jpy-rate", type=float, default=DEFAULT_JPY_PER_USD, help="USD→JPY の概算レート（既定 %.0f）" % DEFAULT_JPY_PER_USD)
    p.add_argument("--keychain", default=None, metavar="SERVICE",
                   help="macOS Keychain のサービス名からキーを読む（環境変数が未設定のときのみ・値は表示しない）")
    p.add_argument("--dry-run", action="store_true",
                   help="API を呼ばず、送信するプロンプト（問い合わせ本文を含む）を標準出力に表示して終了")
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    try:
        if args.config:
            cfg = load_config(args.config)  # 明示指定は存在しない・壊れているならエラー（黙って既定に戻さない）
        else:
            default_path = os.path.join(HERE, "config.json")
            cfg = load_config(default_path if os.path.exists(default_path) else None)
    except (OSError, ValueError) as e:
        sys.stderr.write("設定の読み込みに失敗（%s）: %s\n" % (args.config or "同梱 config.json", e))
        return 1
    model = args.model or cfg.get("model") or DEFAULT_MODEL

    if args.dry_run:
        for path in args.inputs:
            try:
                inquiry = read_inquiry(path)
                system_prompt, user_prompt = build_prompts(cfg, inquiry["text"], args.prompts_dir)
                body = build_request_body(cfg, system_prompt, user_prompt, model)
            except (OSError, ValueError) as e:
                sys.stderr.write("[NG] %s: %s\n" % (path, e))
                return 2
            print("=" * 70)
            print("[dry-run] %s → model=%s max_tokens=%d" % (path, body["model"], body["max_tokens"]))
            print("-" * 30 + " system")
            print(system_prompt)
            print("-" * 30 + " user")
            print(user_prompt)
        return 0

    try:
        check_output_collisions(args.inputs, args.out_dir)
    except ValueError as e:
        sys.stderr.write("%s\n" % e)
        return 2

    api_key = resolve_api_key(args.keychain)
    if not api_key:
        sys.stderr.write("API キーが見つかりません（環境変数 ANTHROPIC_API_KEY 未設定%s）。実行例:\n"
                         "  ANTHROPIC_API_KEY=... python3 reply_assistant.py --in inquiries/*.txt --out drafts/\n"
                         "  python3 reply_assistant.py --keychain apiguard.ANTHROPIC_API_KEY ...   # macOS Keychain\n"
                         % ("・Keychain '%s' に未登録" % args.keychain if args.keychain else ""))
        return 2

    totals = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
    total_cost = 0.0
    cost_known = True
    ok, failed = 0, 0
    for path in args.inputs:
        try:
            result = process_inquiry(path, cfg, api_key, model, args.prompts_dir)
        except (ApiError, OSError, ValueError) as e:
            failed += 1
            sys.stderr.write("[NG] %s: %s\n" % (path, e))
            failed_usage = getattr(e, "usage", None)
            if failed_usage:  # 打ち切り・拒否でも消費したトークンは集計に含める
                for k in totals:
                    totals[k] += failed_usage[k]
                failed_cost = estimate_cost_usd(model, failed_usage)
                if failed_cost is None:
                    cost_known = False
                else:
                    total_cost += failed_cost
            if isinstance(e, ApiError) and e.status in (401, 403):
                sys.stderr.write("認証エラーのため中断します\n")
                break
            continue
        paths = write_outputs(result, args.out_dir)
        ok += 1
        for k in totals:
            totals[k] += result["usage"][k]
        if result["cost_usd"] is None:
            cost_known = False
        else:
            total_cost += result["cost_usd"]
        print("[OK] %s → %s (%s / 緊急度 %s / in %d, out %d tok)" % (
            path, paths["md"], result["category"], result["urgency"],
            result["usage"]["input_tokens"], result["usage"]["output_tokens"]))

    summary = {
        "model": model,
        "files_ok": ok,
        "files_failed": failed,
        "api_calls": ok + failed,
        "usage": totals,
        "cost_usd": round(total_cost, 6) if cost_known else None,
        "cost_jpy": round(total_cost * args.jpy_rate, 2) if cost_known else None,
        "jpy_per_usd": args.jpy_rate,
        "note": "費用は input/output トークン × 公開単価の概算。為替レートは固定の概算値。",
        "generated_at": _dt.datetime.now(_dt.timezone.utc).astimezone().isoformat(timespec="seconds"),
    }
    if ok or totals["input_tokens"] or totals["output_tokens"]:
        os.makedirs(args.out_dir, exist_ok=True)
        with open(os.path.join(args.out_dir, USAGE_STEM + ".json"), "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)
            f.write("\n")
    cost_line = ("$%.5f ≈ ¥%.2f (@%.0f)" % (total_cost, total_cost * args.jpy_rate, args.jpy_rate)
                 if cost_known else "不明")
    print("合計: %d 通成功 / %d 通失敗 / 入力 %d tok / 出力 %d tok / 概算 %s" % (
        ok, failed, totals["input_tokens"], totals["output_tokens"], cost_line))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
