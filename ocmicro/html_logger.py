"""Session logs as HTML pages, laid out like the pages in session_log/.

Each session gets its own folder:

  <log dir>/<UTC start>-<session id>/
    index.html                      links to every page below
    session/00_session_setup.html   where and how the session runs
    session/01_user_prompt.html     every prompt typed this session
    session/turns/turn_NN.html      one model request each, with the tool calls it asked for
    session/99_session_end.html     totals, written when the session ends

Every entry starts with a header line carrying its own timestamp, which the viewer
script on each page folds on:

  [HH:MM:SS.mmm +elapsed] ── KIND ── scope · detail · detail

Pages are rewritten after every entry, so they are complete even if ocmicro dies
mid-turn.
"""

import datetime
import html
import json
import os
import platform
import sys
import time
import traceback
import urllib.error

_log = None  # the running session's log, set by start()


def start(log_dir, session, model, effort, base_url, tools):
    """Create this session's log folder and write its setup page. Returns the index page's path."""
    global _log
    _log = _Log(log_dir, session, model, effort, base_url, tools)
    return os.path.join(_log.root, "index.html")


def user_prompt(prompt):
    if _log:
        _log.user_prompt(prompt)


def turn_start():
    if _log:
        _log.turn_start()


def request(req, body):
    if _log:
        _log.request(req, body)


def response(r, data):
    if _log:
        _log.response(r, data)


def tool_call(call):
    if _log:
        _log.tool_call(call)


def tool_result(call, output):
    if _log:
        _log.tool_result(call, output)


def turn_end(calls):
    if _log:
        _log.turn_end(calls)


def session_end(error=None):
    """Write the end page. `error` is the exception that ended the session, if any."""
    if _log:
        _log.session_end(error)


class _Log:
    def __init__(self, log_dir, session, model, effort, base_url, tools):
        self.t0 = time.monotonic()
        self.started = datetime.datetime.now(datetime.timezone.utc)
        self.root = os.path.join(os.path.abspath(log_dir), f"{self.started:%Y%m%dT%H%M%SZ}-{session}")
        self.model = model
        self.effort = effort
        self.prompts = []  # (prompt, number of its first turn)
        self.prompt_text = ""
        self.turn = 0
        self.turn_text = ""
        self.turn_note = ""
        self.turn_open = False
        self.request_at = 0.0
        self.tools = 0
        self.tool_starts = {}  # call_id -> (tool number, start time)
        self.usage = {"in": 0, "cached": 0, "out": 0, "reasoning": 0}
        self.errors = 0
        self.ended = False
        os.makedirs(os.path.join(self.root, "session", "turns"), exist_ok=True)

        offset = datetime.datetime.now().astimezone().strftime("%z")
        utc = self.started.strftime("%Y-%m-%dT%H:%M:%S.") + f"{self.started.microsecond // 1000:03d}Z"
        header = "════════ ocmicro session log ════════\n" + _indent(_fields(
            ("started", f"{utc}   (block times below are local, UTC{offset[:3]}:{offset[3:]})"),
            ("ocmicro", f"pid {os.getpid()}   python {platform.python_version()}   {sys.platform} {platform.machine()}"),
            ("cwd", os.getcwd()),
            ("log dir", self.root),
        ).rstrip("\n"), 2) + "\n\n"
        names = [tool["name"] for tool in tools]
        setup = header + self._entry("SESSION", body=_fields(
            ("id", session),
            ("model", f"openai/{model}"),
            ("base url", base_url),
            ("effort", effort),
            ("tools", f"{len(names)}: {', '.join(names)}"),
        ))
        self._write("session/00_session_setup.html", _page("00_session_setup.log", setup))
        self._write_index()

    # Entries

    def _entry(self, kind, *details, body=""):
        now = datetime.datetime.now()
        stamp = now.strftime("%H:%M:%S.") + f"{now.microsecond // 1000:03d}"
        elapsed = time.monotonic() - self.t0
        head = f"[{stamp} +{elapsed:.3f}s] ── {kind} ── " + " · ".join(("main",) + details)
        body = body.rstrip("\n")
        return head + "\n" + (_indent(body, 2) + "\n" if body else "") + "\n"

    def _add(self, entry):
        self.turn_text += entry
        self._write_turn(self.turn, self.turn_text, self.turn_note, has_next=False)

    def user_prompt(self, prompt):
        self.prompts.append((prompt, self.turn + 1))
        self.prompt_text += self._entry("USER PROMPT", f"before turn {self.turn + 1}", body=prompt)
        self._write("session/01_user_prompt.html", _page("01_user_prompt.log", self.prompt_text))
        self._write_index()

    def turn_start(self):
        if self.turn:
            self._write_turn(self.turn, self.turn_text, self.turn_note, has_next=True)
        self.turn += 1
        self.turn_open = True
        self.turn_note = ""
        if self.prompts and self.prompts[-1][1] == self.turn:
            self.turn_note = f'This turn starts work on <a href="../01_user_prompt.html">prompt {len(self.prompts)}</a>.'
        self.turn_text = ""
        self._add(self._entry(f"TURN {self.turn}", f"openai/{self.model}", f"effort {self.effort}"))
        self._write_index()

    def request(self, req, body):
        self.request_at = time.monotonic()
        headers = "\n".join(f"{name.lower()}: {_redact(name, value)}" for name, value in req.header_items())
        self._add(self._entry(
            f"REQUEST #{self.turn}", f"turn {self.turn}",
            body=f"{req.get_method()} {req.full_url}   ({len(req.data):,} bytes)\n"
            f"headers\n{_indent(headers, 2)}\nbody\n{_indent(_json(body), 2)}",
        ))

    def response(self, r, data):
        took = time.monotonic() - self.request_at
        headers = "\n".join(f"{name.lower()}: {value}" for name, value in r.headers.items())
        self._add(self._entry(
            f"RESPONSE #{self.turn}", f"turn {self.turn}", f"{r.status} {r.reason}", _duration(took),
            body=f"headers\n{_indent(headers, 2)}\nbody\n{_indent(_json(data), 2)}",
        ))

        items = data.get("output", [])
        reasoning = "\n".join(part["text"] for item in items if item["type"] == "reasoning" for part in item.get("summary", []))
        text = "".join(
            part.get("text", "") for item in items if item["type"] == "message"
            for part in item.get("content", []) if part.get("type") == "output_text"
        )
        encrypted = sum(len(item.get("encrypted_content") or "") for item in items if item["type"] == "reasoning")
        calls = [item for item in items if item["type"] == "function_call"]
        usage = data.get("usage") or {}
        step = {
            "in": usage.get("input_tokens", 0),
            "cached": (usage.get("input_tokens_details") or {}).get("cached_tokens", 0),
            "out": usage.get("output_tokens", 0),
            "reasoning": (usage.get("output_tokens_details") or {}).get("reasoning_tokens", 0),
        }
        for name in self.usage:
            self.usage[name] += step[name]
        tool_lines = "\n".join(f"{c['name']} {c['call_id']} {c.get('arguments', '')}" for c in calls)
        self._add(self._entry(
            f"RESPONSE #{self.turn} SUMMARY", f"turn {self.turn}", f"status {data.get('status', '?')}", _count(len(calls), "tool call"),
            body=_fields(("took", _duration(took)), ("response", data.get("id", "?")))
            + f"reasoning\n{_indent(reasoning or '(none)', 2)}\n"
            + f"text\n{_indent(text or '(none)', 2)}\n"
            + _fields(("encrypted", f"{encrypted:,} bytes of reasoning"))
            + f"tool calls\n{_indent(tool_lines or '(none)', 2)}\n"
            + _fields(
                ("usage", _usage(step)),
                ("session", f"turns {self.turn} · {_usage(self.usage)} · tool calls {self.tools + len(calls)}"),
            ),
        ))

    def tool_call(self, call):
        self.tools += 1
        self.tool_starts[call["call_id"]] = (self.tools, time.monotonic())
        try:
            args = _json(json.loads(call.get("arguments") or "{}"))
        except ValueError:
            args = call.get("arguments", "")
        self._add(self._entry(
            f"TOOL #{self.tools}", f"turn {self.turn}", f"{call['name']} {call['call_id']}",
            body=f"args\n{_indent(args, 2)}",
        ))

    def tool_result(self, call, output):
        number, began = self.tool_starts.pop(call["call_id"], (self.tools, time.monotonic()))
        self._add(self._entry(
            f"TOOL #{number} END", f"turn {self.turn}", f"{call['name']} {call['call_id']}",
            "ok", _duration(time.monotonic() - began),
            body=f"output   ({len(output):,} chars, as sent to the model)\n{_indent(output, 2)}",
        ))

    def turn_end(self, calls):
        outcome = ("continue", _count(len(calls), "tool call")) if calls else ("stop", "answered")
        self._add(self._entry(f"TURN {self.turn} END", *outcome))
        self.turn_open = False

    def session_end(self, error):
        if self.ended:
            return
        self.ended = True
        if isinstance(error, EOFError):
            exit = "completed (end of input)"
        elif isinstance(error, KeyboardInterrupt):
            exit = "interrupted (Ctrl-C)"
        elif error is None:
            exit = "completed"
        else:
            exit = f"error ({type(error).__name__})"
            self.errors += 1

        entry = ""
        if isinstance(error, KeyboardInterrupt) and self.turn_open:
            entry = self._entry("INTERRUPT", f"turn {self.turn}", body="Ctrl-C while the turn was running")
        elif exit.startswith("error"):
            detail = ""
            if isinstance(error, urllib.error.HTTPError):
                try:
                    raw = error.read().decode(errors="replace")
                    detail = f"HTTP {error.code} {error.reason}\nbody\n{_indent(_json_or_text(raw), 2)}\n"
                except Exception:
                    detail = f"HTTP {error.code} {error.reason}\n"
            trace = "".join(traceback.format_exception(type(error), error, error.__traceback__)).rstrip("\n")
            scope = (f"turn {self.turn}",) if self.turn_open else ()
            entry = self._entry("ERROR", *scope, type(error).__name__, body=detail + f"traceback\n{_indent(trace, 2)}")
        if entry and self.turn_open:
            self._add(entry)
            entry = ""

        now = datetime.datetime.now()
        stamp = now.strftime("%H:%M:%S.") + f"{now.microsecond // 1000:03d}"
        end = f"════════ session end ════════ [{stamp}]\n" + _indent(_fields(
            ("exit", f"{exit}   wall {_duration(time.monotonic() - self.t0)}"),
            ("prompts", f"{len(self.prompts)}   turns {self.turn}   requests {self.turn}"),
            ("tokens", _usage(self.usage)),
            ("tools", f"bash {self.tools}"),
            ("errors", str(self.errors)),
        ).rstrip("\n"), 2) + "\n\n" + entry
        self._write("session/99_session_end.html", _page("99_session_end.log", end))
        if self.turn:
            self._write_turn(self.turn, self.turn_text, self.turn_note, has_next=False)
        self._write_index()

    # Pages

    def _write(self, path, content):
        # Write beside the page, then swap it in, so a reload never shows half a page.
        target = os.path.join(self.root, path)
        with open(target + ".tmp", "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(target + ".tmp", target)

    def _write_turn(self, n, text, note, has_next):
        prev = f'<a href="turn_{n - 1:02d}.html" rel="prev">← Previous turn</a>' if n > 1 else '<button type="button" disabled>← Previous turn</button>'
        nxt = f'<a href="turn_{n + 1:02d}.html" rel="next">Next turn →</a>' if has_next else '<button type="button" disabled>Next turn →</button>'
        nav = f"""  <header class="turn-header">
    <nav class="turn-navigation" aria-label="Turn navigation">
      <a href="../../index.html">← Back to index</a>
      <span class="turn-position">Turn {n:02d}</span>
      <div class="turn-pagination">
        {prev}
        {nxt}
      </div>
    </nav>
  </header>
"""
        self._write(f"session/turns/turn_{n:02d}.html", _page(f"turn_{n:02d}.log", text, nav=nav, note=note))

    def _write_index(self):
        first = self.prompts[0][0].strip().split("\n")[0] if self.prompts else ""
        subtitle = _snippet(first, 80) or "No prompt yet"
        groups = []
        for i, (prompt, first_turn) in enumerate(self.prompts):
            last_turn = self.prompts[i + 1][1] - 1 if i + 1 < len(self.prompts) else self.turn
            links = "\n".join(
                f'          <li><a href="session/turns/turn_{n:02d}.html">Turn {n:02d}</a></li>'
                for n in range(first_turn, last_turn + 1)
            )
            groups.append(
                f'        <p class="muted prompt-label">Prompt {i + 1} · {html.escape(_snippet(prompt, 100))}</p>\n'
                + (f'        <ul class="turns">\n{links}\n        </ul>' if links else '        <p class="muted">No turns yet</p>')
            )
        turns = "\n".join(groups) or '        <p class="muted">No turns yet</p>'
        if self.ended:
            end = """        <a href="session/99_session_end.html">
          <strong>Final summary</strong>
          <span>Exit status, elapsed time, token usage, and tool totals</span>
        </a>"""
        else:
            end = '        <p class="muted">Still running. The summary appears here when the session ends.</p>'
        started = self.started.astimezone().strftime("%Y-%m-%d %H:%M:%S")
        page = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Session log · {html.escape(_snippet(first, 60) or self.root.rsplit("-", 1)[-1])}</title>
  <style>{INDEX_STYLE}  </style>
</head>
<body>
  <main>
    <header>
      <h1>Session log</h1>
      <p>{html.escape(subtitle)}</p>
      <p class="muted">{_count(self.turn, "turn")} · {_count(self.turn, "request")} · {_count(len(self.prompts), "prompt")} · started {started}</p>
      <p class="muted">Open a section, then click a timestamped entry to expand it. Expand JSON and click a string to preview its decoded text.</p>
    </header>

    <nav aria-label="Session log contents">
      <section aria-labelledby="start-heading">
        <h2 id="start-heading">Session start</h2>
        <ul class="sections">
          <li>
            <a href="session/00_session_setup.html">
              <strong>Session setup</strong>
              <span>Environment, model, and session details</span>
            </a>
          </li>
          <li>
            <a href="session/01_user_prompt.html">
              <strong>User prompts</strong>
              <span>Everything typed to the agent this session</span>
            </a>
          </li>
        </ul>
      </section>

      <section aria-labelledby="turns-heading">
        <h2 id="turns-heading">Turns</h2>
{turns}
      </section>

      <section aria-labelledby="end-heading">
        <h2 id="end-heading">Session end</h2>
{end}
      </section>
    </nav>
  </main>
</body>
</html>
"""
        self._write("index.html", page)


def _page(title, text, nav="", note=""):
    script = FOLD_SCRIPT
    nav_style = ""
    if nav:
        # On turn pages the controls sit inside the sticky navigation bar.
        script = script.replace("document.body.prepend(toolbar);", 'document.querySelector(".turn-header").append(toolbar);')
        nav_style = f'  <style id="turn-navigation-style">{NAV_STYLE}  </style>\n'
    note = f'    <p class="mb-3">{note}</p>\n' if note else ""
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" rel="stylesheet">

  <style id="json-fold-style">{FOLD_STYLE}  </style>
{nav_style}</head>
<body class="bg-body-tertiary">
{nav}  <main class="container-fluid p-3 p-md-4">
{note}    <div class="card shadow-sm">
      <div class="card-body p-0">
        <pre class="m-0 p-3 overflow-auto bg-body font-monospace" style="white-space: pre; tab-size: 4;">{html.escape(text, quote=False)}</pre>
      </div>
    </div>
  </main>

  <script id="json-fold-script">{script}  </script>
</body>
</html>
"""


# Formatting


def _indent(text, n):
    return "\n".join(" " * n + line for line in text.split("\n")) if text else ""


def _fields(*pairs):
    return "".join(f"{name:<12}{value}\n" for name, value in pairs)


def _json(value):
    return json.dumps(value, indent=2, ensure_ascii=False)


def _json_or_text(raw):
    try:
        return _json(json.loads(raw))
    except ValueError:
        return raw


def _redact(name, value):
    return "Bearer [redacted:api-key]" if name.lower() == "authorization" else value


def _duration(seconds):
    if seconds < 1:
        return f"{seconds * 1000:.0f}ms"
    if seconds < 60:
        return f"{seconds:.2f}s"
    return f"{int(seconds // 60)}m{int(seconds % 60):02d}s"


def _usage(u):
    return f"in {u['in']:,} · cached {u['cached']:,} · out {u['out']:,} (reasoning {u['reasoning']:,})"


def _count(n, noun):
    return f"{n} {noun}{'' if n == 1 else 's'}"


def _snippet(text, limit):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


# Viewer styles and script, copied from the pages in session_log/.

INDEX_STYLE = r"""
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f8f9fa;
      color: #212529;
      font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { max-width: 960px; margin: 0 auto; padding: 3rem 1.25rem; }
    header { margin-bottom: 2rem; }
    h1 { margin: 0 0 .5rem; font-size: 2rem; line-height: 1.2; }
    h2 { margin: 0 0 .75rem; font-size: 1.15rem; }
    p { margin: .5rem 0; }
    .muted { color: #626b73; }
    section + section { margin-top: 2rem; }
    ul { margin: 0; padding: 0; list-style: none; }
    .sections, .turns { display: grid; gap: .75rem; }
    .sections { grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
    .turns { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
    a {
      display: block;
      height: 100%;
      padding: 1rem;
      border: 1px solid #dee2e6;
      border-radius: .5rem;
      background: #fff;
      color: #0b5ed7;
      text-decoration: none;
    }
    a:hover { border-color: #0b5ed7; background: #f0f6ff; }
    a:focus-visible { outline: 3px solid #0b5ed7; outline-offset: 3px; }
    a strong { display: block; font-weight: 600; }
    a span { display: block; margin-top: .25rem; color: #626b73; font-size: .875rem; }
    .turns a { text-align: center; font-weight: 600; }
    .prompt-label { margin: 1rem 0 .5rem; }
    @media (prefers-color-scheme: dark) {
      body { background: #181b1f; color: #f1f3f5; }
      .muted, a span { color: #adb5bd; }
      a { background: #212529; border-color: #495057; color: #8bb9ff; }
      a:hover { background: #28384e; border-color: #8bb9ff; }
      a:focus-visible { outline-color: #8bb9ff; }
    }
"""

FOLD_STYLE = r"""
    .json-fold-toolbar {
      position: sticky;
      top: 0;
      z-index: 1000;
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: .4rem;
      padding: .45rem .75rem;
      border-bottom: 1px solid var(--bs-border-color, #dee2e6);
      background: rgba(255, 255, 255, .96);
      backdrop-filter: blur(4px);
    }
    .json-fold-toolbar button {
      border: 1px solid var(--bs-border-color, #ced4da);
      border-radius: .35rem;
      padding: .2rem .55rem;
      background: var(--bs-body-bg, #fff);
      color: var(--bs-body-color, #212529);
      font: 12px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
    }
    .json-fold-toolbar button:hover {
      background: var(--bs-tertiary-bg, #f8f9fa);
    }
    .log-entry + .log-entry {
      border-top: 1px solid var(--bs-border-color, #dee2e6);
    }
    .log-entry > summary {
      padding: .75rem 1rem;
      background: var(--bs-body-bg, #fff);
      color: var(--bs-body-color, #212529);
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      cursor: pointer;
    }
    .log-entry > summary:hover {
      background: var(--bs-tertiary-bg, #f8f9fa);
    }
    .log-entry > summary:focus-visible {
      outline: 2px solid #0b5ed7;
      outline-offset: -2px;
    }
    .log-entry-body {
      margin: 0;
      padding: 0 1rem 1rem;
      overflow: auto;
      background: var(--bs-body-bg, #fff);
      color: var(--bs-body-color, #212529);
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre;
      tab-size: 4;
    }
    .json-tree {
      display: inline-block;
      min-width: max-content;
      vertical-align: top;
      --json-indent: 1.4rem;
    }
    .json-tree-node {
      display: inline-block;
      vertical-align: top;
    }
    .json-tree-node > summary {
      display: inline-block;
      cursor: pointer;
      list-style: none;
      user-select: none;
      border-radius: 2px;
      padding: 0 .12rem;
    }
    .json-tree-node > summary::-webkit-details-marker { display: none; }
    .json-tree-node > summary::before {
      content: "\25B8";
      display: inline-block;
      width: 1em;
      margin-right: .15rem;
      color: #6c757d;
    }
    .json-tree-node[open] > summary::before { content: "\25BE"; }
    .json-tree-node > summary:hover,
    .json-tree-node > summary:focus-visible {
      background: rgba(127, 127, 127, .16);
      outline: none;
    }
    .json-tree-node[open] > summary .json-tree-ellipsis { display: none; }
    .json-tree-node[open] > summary .json-tree-close-inline { display: none; }
    .json-tree-children {
      display: block;
      margin-left: var(--json-indent);
      border-left: 1px dotted rgba(127, 127, 127, .42);
      padding-left: .75rem;
    }
    .json-tree-row {
      display: block;
      min-height: 1.25em;
    }
    .json-string-link {
      appearance: none;
      border: 0;
      border-radius: 2px;
      padding: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      white-space: inherit;
      cursor: pointer;
      text-decoration: underline dotted;
      text-underline-offset: .2em;
    }
    .json-string-link:hover { background: rgba(127, 127, 127, .12); }
    .json-string-link:focus-visible {
      outline: 2px solid #0b5ed7;
      outline-offset: 2px;
    }
    .json-string-dialog {
      box-sizing: border-box;
      width: min(72rem, calc(100vw - 2rem));
      max-width: none;
      max-height: calc(100vh - 2rem);
      margin: auto;
      padding: 0;
      border: 1px solid var(--bs-border-color, #dee2e6);
      border-radius: .6rem;
      background: var(--bs-body-bg, #fff);
      color: var(--bs-body-color, #212529);
      box-shadow: 0 1rem 3rem rgba(0, 0, 0, .25);
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .json-string-dialog[open] { display: flex; flex-direction: column; }
    .json-string-dialog::backdrop { background: rgba(0, 0, 0, .55); }
    .json-string-header {
      display: flex;
      flex-shrink: 0;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: .75rem 1rem;
      border-bottom: 1px solid var(--bs-border-color, #dee2e6);
    }
    .json-string-header h2 { margin: 0; font-size: 1rem; }
    .json-string-header button {
      border: 1px solid var(--bs-border-color, #ced4da);
      border-radius: .35rem;
      padding: .25rem .65rem;
      background: var(--bs-tertiary-bg, #f8f9fa);
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .json-string-content {
      min-height: 0;
      margin: 0;
      padding: 1rem;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      tab-size: 4;
      font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .json-tree-key { font-weight: 600; }
    .json-tree-colon { margin-right: .25rem; }
    .json-tree-close {
      display: block;
      margin-left: 1em;
    }
    .json-tree-string { color: #0a7b34; }
    .json-tree-number { color: #0b5ed7; }
    .json-tree-boolean { color: #8250df; }
    .json-tree-null { color: #6c757d; font-style: italic; }
    .json-tree-ellipsis { color: #6c757d; }
    @media (prefers-color-scheme: dark) {
      .json-fold-toolbar { background: rgba(33, 37, 41, .96); }
      .json-tree-string { color: #75d39a; }
      .json-tree-number { color: #75b7ff; }
      .json-tree-boolean { color: #c5a3ff; }
    }
"""

NAV_STYLE = r"""
    .turn-header {
      position: sticky;
      top: 0;
      z-index: 1000;
      background: var(--bs-body-bg, #fff);
    }
    .turn-header .json-fold-toolbar { position: static; }
    .turn-navigation {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: .75rem;
      padding: .75rem;
      border-bottom: 1px solid var(--bs-border-color, #dee2e6);
      font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .turn-pagination { display: flex; flex-wrap: wrap; gap: .5rem; }
    .turn-navigation a, .turn-navigation button {
      display: inline-block;
      border: 1px solid var(--bs-border-color, #ced4da);
      border-radius: .35rem;
      padding: .4rem .7rem;
      background: var(--bs-body-bg, #fff);
      color: #0b5ed7;
      font: inherit;
      text-decoration: none;
    }
    .turn-navigation a:hover { background: var(--bs-tertiary-bg, #f8f9fa); }
    .turn-navigation a:focus-visible { outline: 2px solid #0b5ed7; outline-offset: 2px; }
    .turn-navigation button:disabled { color: #6c757d; opacity: .65; cursor: default; }
    .turn-position { color: var(--bs-body-color, #212529); }
"""

FOLD_SCRIPT = r"""
  (() => {
    "use strict";

    function matchingEnd(text, start) {
      const first = text[start];
      if (first !== "{" && first !== "[") return -1;
      const stack = [first === "{" ? "}" : "]"];
      let inString = false;
      let escaped = false;
      for (let i = start + 1; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{") stack.push("}");
        else if (ch === "[") stack.push("]");
        else if (ch === "}" || ch === "]") {
          if (!stack.length || stack[stack.length - 1] !== ch) return -1;
          stack.pop();
          if (!stack.length) return i;
        }
      }
      return -1;
    }

    function findJsonRanges(text) {
      const ranges = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== "{" && text[i] !== "[") continue;
        const end = matchingEnd(text, i);
        if (end < 0) continue;
        const candidate = text.slice(i, end + 1);
        try {
          JSON.parse(candidate);
          ranges.push([i, end + 1]);
          i = end;
        } catch (_) {}
      }
      return ranges;
    }

    // Parse JSON into a structural tree while retaining exact source ranges for every token.
    function parseExactJson(text) {
      let i = 0;
      const ws = () => { while (i < text.length && /[\x20\t\r\n]/.test(text[i])) i++; };

      function stringToken() {
        const start = i;
        if (text[i++] !== '"') throw new Error("string");
        let escaped = false;
        while (i < text.length) {
          const ch = text[i++];
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') return { start, end: i };
        }
        throw new Error("unterminated string");
      }

      function primitive(type) {
        const start = i;
        if (type === "string") {
          const t = stringToken();
          return { type, start: t.start, end: t.end };
        }
        if (type === "number") {
          const m = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
          if (!m) throw new Error("number");
          i += m[0].length;
          return { type, start, end: i };
        }
        const lit = type === "boolean" ? (text.startsWith("true", i) ? "true" : "false") : "null";
        if (!text.startsWith(lit, i)) throw new Error(type);
        i += lit.length;
        return { type, start, end: i };
      }

      function value() {
        ws();
        const start = i;
        const ch = text[i];
        if (ch === "{") {
          i++; ws();
          const props = [];
          if (text[i] !== "}") {
            while (true) {
              ws();
              const key = stringToken();
              ws();
              if (text[i++] !== ":") throw new Error("colon");
              const val = value();
              props.push({ key, value: val });
              ws();
              if (text[i] === ",") { i++; continue; }
              break;
            }
          }
          if (text[i++] !== "}") throw new Error("object close");
          return { type: "object", start, end: i, children: props };
        }
        if (ch === "[") {
          i++; ws();
          const items = [];
          if (text[i] !== "]") {
            while (true) {
              items.push(value());
              ws();
              if (text[i] === ",") { i++; continue; }
              break;
            }
          }
          if (text[i++] !== "]") throw new Error("array close");
          return { type: "array", start, end: i, children: items };
        }
        if (ch === '"') return primitive("string");
        if (ch === "t" || ch === "f") return primitive("boolean");
        if (ch === "n") return primitive("null");
        return primitive("number");
      }

      const root = value();
      ws();
      if (i !== text.length) throw new Error("trailing content");
      return root;
    }

    function span(cls, value) {
      const el = document.createElement("span");
      if (cls) el.className = cls;
      el.textContent = value;
      return el;
    }

    function renderString(source, cls) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "json-string-link " + cls;
      button.textContent = source;
      button.title = "Preview rendered string";
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-controls", "json-string-preview");
      button.addEventListener("click", () => {
        // Decode exactly one JSON layer and keep log content as text, including HTML.
        content.textContent = JSON.parse(source);
        dialog.showModal();
        content.scrollTop = 0;
        content.scrollLeft = 0;
      });
      return button;
    }

    function renderTree(jsonText) {
      let ast;
      try { ast = parseExactJson(jsonText); }
      catch (_) { return document.createTextNode(jsonText); }

      function renderValue(node) {
        if (node.type === "string") {
          return renderString(jsonText.slice(node.start, node.end), "json-tree-primitive json-tree-string");
        }
        if (node.type !== "object" && node.type !== "array") {
          return span("json-tree-primitive json-tree-" + node.type, jsonText.slice(node.start, node.end));
        }

        const isObj = node.type === "object";
        const openChar = isObj ? "{" : "[";
        const closeChar = isObj ? "}" : "]";
        const details = document.createElement("details");
        details.className = "json-tree-node";
        details.dataset.jsonSource = jsonText.slice(node.start, node.end);

        const summary = document.createElement("summary");
        summary.append(
          span("json-tree-open", openChar),
          span("json-tree-ellipsis", node.children.length ? " ... " : ""),
          span("json-tree-close-inline", closeChar)
        );
        details.append(summary);

        if (node.children.length) {
          const children = document.createElement("div");
          children.className = "json-tree-children";

          node.children.forEach((entry, index) => {
            const row = document.createElement("div");
            row.className = "json-tree-row";
            if (isObj) {
              row.append(
                renderString(jsonText.slice(entry.key.start, entry.key.end), "json-tree-key"),
                span("json-tree-colon", ": "),
                renderValue(entry.value)
              );
            } else {
              row.append(renderValue(entry));
            }
            if (index < node.children.length - 1) row.append(span("json-tree-comma", ","));
            children.append(row);
          });
          details.append(children);
        }
        details.append(span("json-tree-close", closeChar));
        return details;
      }

      const tree = document.createElement("span");
      tree.className = "json-tree";
      tree.dataset.jsonSource = jsonText;
      tree.append(renderValue(ast));
      return tree;
    }

    function enhancePre(pre) {
      const original = pre.textContent;
      const ranges = findJsonRanges(original);
      if (!ranges.length) return 0;

      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const [start, end] of ranges) {
        if (start > cursor) fragment.append(document.createTextNode(original.slice(cursor, start)));
        fragment.append(renderTree(original.slice(start, end)));
        cursor = end;
      }
      if (cursor < original.length) fragment.append(document.createTextNode(original.slice(cursor)));
      pre.replaceChildren(fragment);
      pre.dataset.originalText = original;
      return ranges.length;
    }

    function foldLog(pre) {
      const original = pre.textContent;
      // Only unindented log headers start entries; timestamps inside tool output stay in their body.
      const headers = Array.from(original.matchAll(/^(?:\[\d{2}:\d{2}:\d{2}\.\d{3} \+\d+(?:\.\d+)?s\] ── |═{8} (?:ocmicro session log|session end) ═{8})[^\r\n]*/gm));
      if (!headers.length) return;

      const entries = document.createElement("div");
      entries.className = "log-entries";
      if (headers[0].index > 0) {
        const prefix = document.createElement("pre");
        prefix.className = "log-entry-body";
        prefix.textContent = original.slice(0, headers[0].index);
        entries.append(prefix);
      }

      headers.forEach((header, index) => {
        const entry = document.createElement("details");
        entry.className = "log-entry";

        const summary = document.createElement("summary");
        summary.textContent = header[0];

        const body = document.createElement("pre");
        body.className = "log-entry-body";
        body.textContent = original.slice(header.index + header[0].length, headers[index + 1]?.index ?? original.length);
        entry.append(summary, body);
        entries.append(entry);
      });
      pre.replaceWith(entries);
    }

    function setAll(selector, collapsed) {
      document.querySelectorAll(selector).forEach((node) => {
        node.open = !collapsed;
      });
    }

    document.querySelectorAll("main pre").forEach(foldLog);
    let count = 0;
    document.querySelectorAll("main pre").forEach((pre) => { count += enhancePre(pre); });
    if (!count && !document.querySelector(".log-entry")) return;

    const dialog = document.createElement("dialog");
    dialog.id = "json-string-preview";
    dialog.className = "json-string-dialog";
    dialog.setAttribute("aria-labelledby", "json-string-title");

    const header = document.createElement("div");
    header.className = "json-string-header";

    const title = document.createElement("h2");
    title.id = "json-string-title";
    title.textContent = "Rendered string";

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.autofocus = true;
    close.addEventListener("click", () => dialog.close());

    const content = document.createElement("pre");
    content.className = "json-string-content";
    content.tabIndex = 0;

    header.append(title, close);
    dialog.append(header, content);
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    dialog.addEventListener("close", () => { content.textContent = ""; });
    document.body.append(dialog);

    // Log entries and all nested JSON objects and arrays start collapsed.
    setAll(".json-tree-node", true);

    const toolbar = document.createElement("div");
    toolbar.className = "json-fold-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Log controls");

    [
      { label: "Expand all entries", selector: ".log-entry", collapsed: false },
      { label: "Collapse all entries", selector: ".log-entry", collapsed: true },
      { label: "Expand all JSON", selector: ".json-tree-node", collapsed: false },
      { label: "Collapse all JSON", selector: ".json-tree-node", collapsed: true },
    ].filter((control) => document.querySelector(control.selector)).forEach((control) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = control.label;
      button.addEventListener("click", () => setAll(control.selector, control.collapsed));
      toolbar.append(button);
    });
    document.body.prepend(toolbar);
  })();
"""
