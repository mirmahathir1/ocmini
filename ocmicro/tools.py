"""The bash tool: its schema for the model, and running the calls the model makes."""

import json
import os
import subprocess
import sys
import tempfile

from bash_description import BASH_DESCRIPTION

MAX_LINES = 2000
MAX_BYTES = 50 * 1024
TMP = os.path.join(tempfile.gettempdir(), "ocmicro")


def bash_tool():
    return {
        "type": "function",
        "name": "bash",
        "description": BASH_DESCRIPTION.format(
            os=sys.platform,
            shell="bash",
            tmp=TMP,
            max_lines=MAX_LINES,
            max_bytes=MAX_BYTES,
        ),
        "parameters": {
            "properties": {
                "command": {"description": "The command to execute", "type": "string"},
                "workdir": {
                    "description": "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.",
                    "type": "string",
                },
            },
            "required": ["command"],
            "type": "object",
        },
        "strict": False,
    }


def tail(text, max_lines, max_bytes):
    # Keep the end of the output, as opencode's shell tool does.
    lines = text.split("\n")
    if len(lines) <= max_lines and len(text.encode()) <= max_bytes:
        return text, False
    out, used = [], 0
    for line in reversed(lines):
        if len(out) >= max_lines:
            break
        size = len(line.encode()) + (1 if out else 0)
        if used + size > max_bytes:
            if not out:
                out.append(line.encode()[-max_bytes:].decode(errors="ignore"))
            break
        out.insert(0, line)
        used += size
    return "\n".join(out), True


def run_bash(args):
    command = args.get("command")
    if not isinstance(command, str) or not command:
        return "Error: The command argument is required."
    cwd = os.path.abspath(os.path.expanduser(args.get("workdir") or os.getcwd()))
    if not os.path.isdir(cwd):
        return f"Error: workdir does not exist: {cwd}"

    os.makedirs(TMP, exist_ok=True)
    fd, path = tempfile.mkstemp(prefix="tool_", suffix=".txt", dir=TMP)
    with os.fdopen(fd, "wb") as sink:
        subprocess.run(
            command,
            shell=True,
            executable="bash",
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=sink,
            stderr=subprocess.STDOUT,
        )

    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(max(0, size - MAX_BYTES * 2))
        raw = f.read().decode(errors="replace")
    output, cut = tail(raw, MAX_LINES, MAX_BYTES)
    cut = cut or size > MAX_BYTES * 2
    if cut:
        output = f"...output truncated...\n\nFull output saved to: {path}\n\n" + output
    else:
        os.remove(path)
    if not output:
        output = "(no output)"
    return output


def call_tool(call):
    if call["name"] != "bash":
        return f"Error: Unknown tool '{call['name']}'. The only available tool is bash."
    try:
        args = json.loads(call.get("arguments") or "{}")
    except ValueError as e:
        return f"Error: Invalid JSON arguments for bash: {e}"
    if not isinstance(args, dict):
        return "Error: bash arguments must be a JSON object."

    return run_bash(args)
