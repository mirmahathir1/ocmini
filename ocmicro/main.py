#!/usr/bin/env python3
"""ocmicro: opencode's agent loop in one file, with a single `bash` tool.

Same request as opencode sends for OpenAI reasoning models, minus streaming: a
stateless Responses API call (store: false) that replays every reasoning item's
encrypted_content, function call, and function output on each request, looping
until a step ends without tool calls.

Usage:
  python3 ocmicro/main.py

Environment:
  API key            read from ocmicro/.openai_key (gitignored)
  OCMICRO_MODEL      default gpt-6-astra
  OCMICRO_EFFORT     reasoning effort, default medium (low, medium, high, xhigh, max)
  OCMICRO_BASE_URL   default https://api.openai.com/v1
  OCMICRO_LOG_DIR    where each session's HTML log folder goes, default ocmicro/logs
"""

import json
import os
import secrets
import urllib.request

import html_logger
import printer
import tools
import utils
from history import History
from printer import DIM, RESET
from system_prompt import SYSTEM_PROMPT

BASE_URL = os.environ.get("OCMICRO_BASE_URL", "https://api.openai.com/v1")
MODEL = os.environ.get("OCMICRO_MODEL", "gpt-6-astra")
MODEL_NAME = "GPT-6 Astra"
EFFORT = os.environ.get("OCMICRO_EFFORT", "medium")
MAX_OUTPUT_TOKENS = 32000
LOG_DIR = os.environ.get("OCMICRO_LOG_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs"))


def step(history, schemas, session, key):
    """One provider turn: send the request, print the reply, return its output items."""
    body = {
        "model": MODEL,
        "input": history.items,
        "max_output_tokens": MAX_OUTPUT_TOKENS,
        "store": False,
        "include": ["reasoning.encrypted_content"],
        "prompt_cache_key": session,
        "reasoning": {"effort": EFFORT, "summary": "auto"},
        "text": {"verbosity": "low"},
        "tools": schemas,
        "tool_choice": "auto",
    }
    request = urllib.request.Request(
        f"{BASE_URL}/responses",
        data=json.dumps(body).encode(),
        headers={
            "authorization": f"Bearer {key}",
            "content-type": "application/json",
            "user-agent": "ocmicro/0.1",
        },
        method="POST",
    )
    html_logger.request(request, body)
    with urllib.request.urlopen(request) as r:
        response = json.load(r)
        html_logger.response(r, response)

    items = response.get("output", [])
    for item in items:
        if item["type"] == "reasoning":
            for part in item.get("summary", []):
                print(f"{DIM}Thinking: {part['text']}{RESET}\n")
        elif item["type"] == "message":
            print("".join(part.get("text", "") for part in item.get("content", []) if part.get("type") == "output_text"))
    return items


def turn(history, schemas, session, key, prompt):
    """Run steps until the model answers without calling a tool, like opencode's session loop."""
    history.add_user_prompt(prompt)
    html_logger.user_prompt(prompt)
    while True:
        html_logger.turn_start()
        # Send the whole conversation so far to the model and get back its reply items:
        # reasoning, text, and any bash calls it wants run before it answers.
        items = step(history, schemas, session, key)
        # Pick out the tool calls the model wants run.
        calls =[item for item in items if item["type"] == "function_call"]
        for call in calls:
            printer.print_call(call)
        outputs = []
        for call in calls:
            html_logger.tool_call(call)
            outputs.append(tools.call_tool(call))
            html_logger.tool_result(call, outputs[-1])
        for output in outputs:
            printer.preview(output)
        # Commit the step only once it is complete, so an interrupt never leaves a
        # function_call without its output in the history.
        history.add_model_output(items)
        history.add_from_outputs(calls, outputs)
        html_logger.turn_end(calls)
        # No tool calls means the model has given its final answer, so the turn is over.
        if not calls:
            return


def main():
    os.makedirs(tools.TMP, exist_ok=True)
    key = utils.api_key()
    session = "ses_" + secrets.token_hex(12)
    history = History()
    history.initialize_history(SYSTEM_PROMPT, utils.environment(MODEL))
    schemas = [tools.bash_tool()]

    log = html_logger.start(LOG_DIR, session, MODEL, EFFORT, BASE_URL, schemas)

    print(f"{DIM}ocmicro · openai/{MODEL} · effort {EFFORT} · {os.getcwd()}")
    print(f"log {log}{RESET}")
    # The loop only ends by exception (Ctrl-D, Ctrl-C or an error), so the end page
    # is written on the way out.
    while True:
        prompt = input("\n> ").strip()
        turn(history, schemas, session, key, prompt)


if __name__ == "__main__":
    main()
