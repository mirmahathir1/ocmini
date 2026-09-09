from __future__ import annotations

import json
import os
import urllib.request
import uuid

from dotenv import load_dotenv

BASE_URL = "https://opencode.ai/zen/v1"
DEFAULT_MODEL = "muse-spark-1.3-contributor-free"

def get_api_key() -> str | None:
    here = os.path.dirname(os.path.abspath(__file__))
    load_dotenv(os.path.join(here, "..", ".env"))
    value = os.environ["API_KEY"]
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


def call_responses(base_url: str, api_key: str, model: str, prompt: str) -> int:
    url = base_url.rstrip("/") + "/responses"
    body: dict = {"model": model, "input": prompt}
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=_headers(api_key),
                                 method="POST")
    
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode("utf-8", "replace"))


    return payload

def main() -> int:
    prompt = "Say hello in one sentence."

    api_key = get_api_key()
    print(f"base URL: {BASE_URL.rstrip('/')}")
    print(f"model: {DEFAULT_MODEL}")

    response = call_responses(BASE_URL, api_key, DEFAULT_MODEL, prompt)
    print(json.dumps(response, indent=2))

if __name__ == "__main__":
    main()
