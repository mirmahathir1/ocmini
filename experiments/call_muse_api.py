from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
import uuid

from dotenv import load_dotenv

BASE_URL = "https://opencode.ai/zen/v1"
DEFAULT_MODEL = "muse-spark-1.3-contributor-free"
REQUIRED_MODEL_SUFFIX = "-contributor-free"


def get_api_key() -> str | None:
    here = os.path.dirname(os.path.abspath(__file__))
    load_dotenv(os.path.join(here, "..", ".env"))

    value = os.environ.get("API_KEY")
    return value.strip()

def _headers(api_key: str) -> dict:
    # Free tier is gated server-side ("free tier can only be used in
    # OpenCode", MissingSessionID without these). Mirror what opencode's
    # CLI sends (see packages/opencode/src/session/llm/request.ts):
    # x-opencode-session / x-opencode-request / User-Agent opencode/*.
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "opencode/1.0.0",
        "X-Title": "opencode",
        "x-opencode-session": str(uuid.uuid4()),
        "x-opencode-request": "msg_" + uuid.uuid4().hex[:24],
        "x-opencode-client": "opencode",
    }


def list_models(base_url: str, api_key: str) -> int:
    """GET {base}/models so the exact model-id spelling can be confirmed."""
    url = base_url.rstrip("/") + "/models"
    req = urllib.request.Request(url, headers=_headers(api_key), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        print(f"HTTP {exc.code} listing models: {exc.read().decode()[:2000]}",
              file=sys.stderr)
        return 4
    except Exception as exc:  # network error, timeout, ...
        print(f"error listing models: {exc}", file=sys.stderr)
        return 4
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        print(body)
        return 0
    models = payload.get("data", payload)
    if isinstance(models, list):
        for entry in models:
            print(entry.get("id") if isinstance(entry, dict) else entry)
    else:
        print(json.dumps(payload, indent=2)[:4000])
    return 0


def _extract_text(payload: dict) -> str:
    """Pull assistant text out of a Responses API payload."""
    # SDK-style convenience field, when present.
    if isinstance(payload.get("output_text"), str) and payload["output_text"]:
        return payload["output_text"]
    chunks: list[str] = []
    output = payload.get("output") or []
    for item in output:
        if not isinstance(item, dict):
            continue
        for content in item.get("content") or []:
            if not isinstance(content, dict):
                continue
            if content.get("type") in ("output_text", "text"):
                text = content.get("text")
                if isinstance(text, str):
                    chunks.append(text)
    return "".join(chunks)


def call_responses(base_url: str, api_key: str, model: str, prompt: str,
                   stream: bool, max_tokens: int | None) -> int:
    url = base_url.rstrip("/") + "/responses"
    body: dict = {"model": model, "input": prompt}
    if stream:
        body["stream"] = True
    if max_tokens is not None:
        body["max_output_tokens"] = max_tokens
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=_headers(api_key),
                                 method="POST")
    
    with urllib.request.urlopen(req, timeout=120) as resp:
        if stream:
            return _print_stream(resp)
        payload = json.loads(resp.read().decode("utf-8", "replace"))


    text = _extract_text(payload)
    print(f"response id: {payload.get('id')}")
    print(f"model: {payload.get('model', model)}")
    usage = payload.get("usage")
    if usage:
        print(f"usage: {json.dumps(usage)}")
    print("--- text ---")
    print(text if text else "(no text in response; full payload below)")
    if not text:
        print(json.dumps(payload, indent=2)[:6000])
    return 0


def _print_stream(resp) -> int:
    """Consume a text/event-stream Responses body, printing deltas live."""
    full_deltas: list[str] = []
    response_id = ""
    # Format is SSE: lines starting with "data: {...}\n".
    buffer = b""
    while True:
        chunk = resp.read(4096)
        if not chunk:
            break
        buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            line = line.strip()
            if not line.startswith(b"data:"):
                continue
            data = line[len(b"data:"):].strip()
            if data == b"[DONE]":
                break
            try:
                event = json.loads(data.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                continue
            etype = event.get("type", "")
            if etype == "response.created" and isinstance(
                    event.get("response"), dict):
                response_id = event["response"].get("id", response_id)
            elif etype in ("response.output_text.delta",
                           "response.text.delta"):
                delta = event.get("delta", "")
                if delta:
                    full_deltas.append(delta)
                    print(delta, end="", flush=True)
            elif etype == "response.completed" and isinstance(
                    event.get("response"), dict):
                response_id = event["response"].get("id", response_id)
    print()
    print(f"--- end of stream (response id: {response_id or 'unknown'}) ---")
    if not full_deltas:
        print("(stream carried no text deltas)", file=sys.stderr)
    return 0


def main() -> int:
    # Fixed demo values — edit here if needed, no CLI flags.
    model = DEFAULT_MODEL
    base_url = BASE_URL
    prompt = "Say hello in one sentence."
    stream = False
    max_tokens: int | None = None

    api_key = get_api_key()
    print(f"base URL: {base_url.rstrip('/')}")
    print(f"model: {model}")

    return call_responses(base_url, api_key, model, prompt,
                          stream, max_tokens)


if __name__ == "__main__":
    raise SystemExit(main())
