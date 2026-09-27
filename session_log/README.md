# Session logs

Every ocmini session writes one plain-text log file. It records what was sent to
the model, what came back, which tools ran and what they returned, what the user
was asked and answered, and what went wrong. When a run misbehaves, the log should
tell you why, so you don't have to run it again.

This folder holds the design and a real example:

| Path | What it is |
|---|---|
| [logplan.md](logplan.md) | The plan, with an "As built" section on where the build departed from it |
| [session/](session/) | One real log (a 25-turn `tsum` build run), split by hand into pieces so it's easier to read. ocmini itself always writes a single file. The unsplit original is [../20260927T030602Z-23167.log](../20260927T030602Z-23167.log) |

The code lives in [packages/opencode/src/session/log.ts](../packages/opencode/src/session/log.ts)
(the logger) and [log-scrub.ts](../packages/opencode/src/session/log-scrub.ts) (the
secret scrubber).

## Turning it on

Logging is always on. Every command that can start a session (the default TUI
command, `run` and `serve`) requires `--log-dir`, and there is no default:

```bash
bun dev --log-dir ~/ocmini-logs .                     # interactive
bun dev run --log-dir ~/ocmini-logs "fix the tests"   # one-shot
```

- If the flag is missing, ocmini prints `--log-dir is required` and exits non-zero.
  `--help`, `--version`, `completion` and `generate` work without it.
- A relative path resolves against `$PWD`, the directory you ran `bun dev` in, not
  `packages/opencode`. `~` is expanded.
- The folder is created if needed. If it can't be created or written to, ocmini exits
  at startup with the path and the reason.

## What ends up in the folder

- **`<UTC timestamp>-<pid>.log`**, for example `20260927T030602Z-23167.log`: one
  file per process. A process runs one session, and its sub-agents, title generation
  and compaction calls all write to the same file.
- **`latest.log`**: a symlink to the newest file. ocmini never prints the log's path,
  so this is how you find the current one.

Nothing is ever deleted. Files grow quickly, because the Responses API resends the
whole conversation on every request. The example run, 25 turns long, is about 18,600
lines. A long run can reach tens of megabytes.

## Reading a log

The file opens with a header, then a series of blocks, and ends with a footer.
Every block starts with a header line in the same format:

```
[HH:MM:SS.mmm +elapsed] ── KIND ── scope · detail · detail
```

The time is local (the header gives the UTC offset), and `+elapsed` counts from
process start. Everything below the header line, indented two spaces, belongs to
that block. JSON is pretty-printed. SSE lines are left exactly as they arrived, each
prefixed with its offset from the request.

That fixed format makes the log easy to grep:

```bash
grep -n '── TURN'          latest.log   # turn boundaries
grep -n '── REQUEST'       latest.log   # every HTTP call to the provider
grep -n '── TOOL #[0-9]* ──' latest.log # tool calls (use 'END ──' for results)
grep -n '── RETRY\|── ERROR\|── LOG' latest.log
```

**Scope** names the session that caused the block: `main` for the top-level session
(`main#2`, … if the process starts more), and `sub#1 explore`, `sub#2 …` for
sub-agents. Turn numbers count agent turns in that scope. A pass through the prompt
loop that only compacts or runs a queued subtask doesn't count as a turn.

### Block kinds

| Block | When it's written | What it holds |
|---|---|---|
| header (`════ ocmini session log ════`) | Process start | Start time and UTC offset, ocmini version and commit, pid, Bun version, platform, cwd, log folder and file, argv, permission mode, config overrides |
| `CONFIG` | Each config file loaded | Its path |
| `SESSION` | A session or sub-agent session is created | Id, parent, directory, title, agent, permission rules |
| `USER PROMPT` | The user submits a prompt | The text, verbatim, prefixed with `> ` |
| `TURN n` / `TURN n END` | Start and end of each agent turn | Agent and model; the outcome, finish reason and running totals |
| `AGENT` | Once per scope and agent, and again if it changes | The tools offered and the permission rules in effect |
| `CONTEXT` | Once per scope, and again if it changes | Instruction files (`AGENTS.md` …) and skills loaded |
| `MODEL` | Once per scope and agent, and again if it changes | Model id with the `-contributor-free` check, base URL, runtime (`ai-sdk` or `native`), provider options (`store`, `include`, reasoning effort), max output |
| `REQUEST #n` | Each HTTP call to the provider | Purpose (`build`, `title`, `compaction` …), method, URL, body size, every header (credentials masked), the full body |
| `RESPONSE #n` | When that response body ends, errors or is cancelled | Status, time to first byte, headers, every raw SSE line with its time offset, and how the stream ended |
| `RESPONSE #n SUMMARY` | When the processor finishes with the call | Response id, text, reasoning summary, encrypted reasoning size, tool calls requested, finish reason, usage, session totals |
| `RETRY` | The retry policy re-runs a call | Attempt number, cause, the error body, the backoff and when the next attempt fires |
| `TOOL #n` / `TOOL #n END` | A tool starts and ends | Arguments; then ok/error/aborted, duration, **the output exactly as the model got it**, truncation details, metadata (values over 1,000 characters show only their size) |
| `PERMISSION` / `PERMISSION REPLY` | A permission check runs and the user answers | Permission, pattern, matched rule and outcome; what the user saw, their choice, how long they took |
| `QUESTION #n` / `ANSWER` / `DISMISSED` | The model asks the user a question | Question, options and recommendation, verbatim; the answer and how long it took; a running question count |
| `SUBAGENT START` / `SUBAGENT END` | The `task` tool starts or finishes a sub-agent | Parent scope and call id, child session, agent, task, prompt, narrowed permissions; status, final result and totals |
| `OVERFLOW` | A context-overflow check fires | Token count, usable window, where the check came from |
| `ERASE TOOL OUTPUT` | Old tool output is erased from context | Which calls were erased and about how many tokens that freed |
| `COMPACTION SCHEDULED` / `START` / `END` | Compaction is scheduled (auto, manual, or after an overflow) and runs | Model, how many messages were summarised and where the verbatim tail starts, the call's tokens. The summary text is in the `RESPONSE #n SUMMARY` of the compaction request just above |
| `TODO` | The todo list is written | The whole list after the write |
| `REMINDER` | A reminder is injected into context | Kind and text |
| `FORMAT` | A formatter runs after an edit or write | Formatter and exit status |
| `ERROR` | An uncaught exception, unhandled rejection, or CLI error | Message and stack |
| `LOG WARN` / `LOG ERROR` | The Effect logger emits Warn or higher | The log line |
| `SIGNAL` | SIGINT/SIGTERM/SIGHUP that ocmini itself handles | The signal |
| footer (`════ session end ════`) | Process exit, signal or crash | Exit reason and code; wall time with time spent waiting on the user and on rate limits; turns, requests (aux), retries, 429s; tokens by category; calls per tool; questions, denials, compactions, errors |

The footer holds the numbers `ocmini-spec.md` §7 grades on, so the log alone is
enough to score a run.

**The file isn't strictly in order.** A `RESPONSE #n` block is written only once
its stream has finished. That keeps concurrent streams, such as the title call that
runs alongside turn 1, from interleaving, but it means the tool calls the model asked
for can appear above the response that requested them (see
[turns/turn_01.log](session/turns/turn_01.log)). If a stream is still open at exit
or crash, its block is written anyway and marked `unfinished`.

## How it works

### One module, synchronous writes

`log.ts` is plain functions, not an Effect service, modelled on
`src/cli/cmd/run/trace.ts`. Each block is one `fs.writeSync` to a file opened in
append mode. So:

- after a crash or kill, the file has everything up to that point, except a
  response that was still streaming (which the exit handler tries to flush);
- blocks from the main thread and the TUI worker never interleave mid-block.

### Startup and handoff to the TUI worker

1. The CLI middleware in [src/index.ts](../packages/opencode/src/index.ts) enforces
   `--log-dir` and calls `SessionLog.start()`.
2. `start()` resolves the folder, creates the file (`ax`, so it can't overwrite an
   existing one), repoints `latest.log`, writes the header, and sets three environment
   variables: `OCMINI_SESSION_LOG` (the file path), `OCMINI_SESSION_LOG_START` (the
   start time) and `OCMINI_SESSION_LOG_PID`.
3. Every other function starts with `enabled()`, which is true only when that
   variable is set **and** the pid matches. The TUI's worker thread shares the pid
   and appends to the same file. Child processes the agent spawns inherit the
   environment but have a different pid, so they don't write to it. In-process tests
   that never call `start()` don't write anything.
4. On the main thread, `start()` also installs exit, crash and signal handlers
   (below).

The session in the TUI runs on the worker thread. When the TUI shuts down, the
worker calls `handoff()`, which flushes any open responses, returns its totals and
stops writing. The main thread passes those totals to `absorb()`, so the single
footer covers the whole run.

### Capturing the wire

The fetch hook sees only a URL and a body. It can't tell which session or purpose a
call is for. So [src/session/llm.ts](../packages/opencode/src/session/llm.ts) wraps
each stream in `SessionLog.withCall({ sessionID, purpose })`, which puts that
context in an `AsyncLocalStorage`.

`SessionLog.tap(input, init, send)` wraps the actual HTTP call. It runs in the
`fetch` wrapper in
[src/provider/provider.ts](../packages/opencode/src/provider/provider.ts) for the
ai-sdk path, and in `providerFetch` in
[src/session/llm/native-runtime.ts](../packages/opencode/src/session/llm/native-runtime.ts)
for the native one. It:

1. reads the call context and writes `REQUEST #n` with the headers and body as sent;
2. awaits `send()` (if the request itself fails, it writes a `RESPONSE #n` with
   `no response` and rethrows);
3. hands the SDK a new `Response` with the same status and headers, and a
   pass-through body. Each chunk is logged as the SDK pulls it and then passed on
   unchanged. The logger never reads ahead and never buffers for a reader that stops
   early;
4. writes `RESPONSE #n` when the body ends, errors, or is cancelled.

The logger only reads the traffic. The wire-parity test in `test/parity/` stays green
with it in place.

Separately, the processor calls `SessionLog.call(sessionID, purpose)` and feeds it
each LLM event. That builds `RESPONSE #n SUMMARY`, the model call as ocmini
understood it, and updates the running token totals. `attempt()` resets it when a
retry re-runs the call.

### Where each block comes from

| Blocks | Hook |
|---|---|
| `--log-dir`, header, `ERROR` for CLI failures | `src/index.ts` |
| Footer, crash, signal | `watch()` in `log.ts`: `process.on("exit" / "uncaughtExceptionMonitor" / "unhandledRejection" / SIGINT / SIGTERM / SIGHUP)` |
| TUI handoff | `src/cli/tui/worker.ts` (`handoff`), `src/cli/cmd/tui.ts` (`absorb`) |
| `CONFIG` | `src/config/config.ts` |
| `SESSION` | `src/session/session.ts` |
| `USER PROMPT`, `TURN`, `AGENT`, `CONTEXT` | `src/session/prompt.ts` |
| `MODEL`, call context | `src/session/llm.ts` |
| `REQUEST`, `RESPONSE` | `src/provider/provider.ts`, `src/session/llm/native-runtime.ts` |
| `RESPONSE SUMMARY`, `RETRY`, `OVERFLOW` | `src/session/processor.ts` |
| `TOOL` | `src/session/tools.ts` |
| `PERMISSION` | `src/permission/index.ts` |
| `QUESTION` | `src/question/index.ts` |
| `SUBAGENT` | `src/tool/task.ts` |
| `ERASE TOOL OUTPUT`, `COMPACTION` | `src/session/compaction.ts` |
| `TODO`, `REMINDER`, `FORMAT` | `src/session/todo.ts`, `src/session/reminders.ts`, `src/format/index.ts` |
| `LOG WARN` / `LOG ERROR` | `Logging.forward()` in `packages/core/src/observability/logging.ts` |

### Exit, crashes and signals

- **Normal exit:** the `exit` handler writes the footer: `completed (0)` or
  `failed (n)`.
- **Uncaught exception:** logged as `ERROR`; the footer reads `crashed: …`.
- **Unhandled rejection:** logged once. If nothing else is listening, the rejection
  is rethrown so the process still dies as it would have, and the rethrow isn't
  logged a second time.
- **SIGINT / SIGTERM / SIGHUP:** if ocmini has no handler of its own for the signal,
  the log writes the footer (`aborted by SIGINT`) and re-raises the signal. If it does
  have one, such as the interactive run loop's Ctrl-C, the log only writes a `SIGNAL`
  block and leaves the rest to that handler.

### Logging never breaks a session

Every write is wrapped. On the first failure (disk full, permissions changed),
ocmini prints one warning to stderr, stops logging and carries on with the session.

### Log state is keyed to the file path

Request and tool numbering, scopes, totals and the failure flag all belong to the
current `OCMINI_SESSION_LOG` path. If the path changes, they all reset. A real run
never changes the path; the tests, which share one process across many logs, rely on
the reset.

## Redaction

Every block goes through the scrubber in `log-scrub.ts` just before it's written, so
all block kinds are treated the same. It changes only the logged copy, never the
bytes sent.

What it masks:

- **Credential headers:** `Authorization`, `Proxy-Authorization`, `Cookie`,
  `Set-Cookie`, and any header whose name contains `key`, `token`, `secret` or
  `password`. The auth scheme stays readable (`Bearer [redacted:api-key …]`). A
  credential seen in a header is then masked wherever else it shows up.
- **Environment secrets:** values of environment variables whose name contains
  `KEY`, `TOKEN`, `SECRET` or `PASSWORD`, collected at startup. Values shorter than
  8 characters, paths, booleans and numbers are skipped.
- **Known token shapes:** `sk-…`, Stripe `sk_/rk_/pk_live|test_…`, GitHub
  `gh?_…` / `github_pat_…`, Slack `xox?-…`, AWS `AKIA…`, JWTs, and
  `-----BEGIN … PRIVATE KEY-----` blocks.
- **Secret-named assignments:** `NAME=value` (including `export NAME=…` and inside
  JSON strings), `"name": "value"` pairs, and `?api_key=` / `token=` / `sig=` style
  query parameters. The name has to *end* in the secret word, so `max_output_tokens`
  and `prompt_cache_key` are left alone.

A masked value becomes `[redacted:<kind> …last4]`, so you can still tell two secrets
apart. Values shorter than 8 characters show no tail. There is deliberately no
high-entropy detection, because it would mangle `encrypted_content` and every hash
in tool output.

This is best effort. Apart from the masked secrets, the file holds exactly what the
provider saw: every prompt, every file the agent read, every command's output.
Treat logs as sensitive.

## Using it for acceptance runs

Put the log folder **outside** the task's working directory. Otherwise the log files
show up in the `ocmini-spec.md` §7 checks for files a run created or modified (and
in `git status`).

## Tests

| File | Covers |
|---|---|
| `packages/opencode/test/session/log.test.ts` | Path resolution, the pid guard, block format, request/stream capture with the auth header masked, summaries, write-failure handling |
| `packages/opencode/test/session/log-scrub.test.ts` | Each token shape, env values, `.env` lines, private keys; `encrypted_content` and look-alike names left alone |
| `packages/opencode/test/session/log-hooks.test.ts` | Permission decisions by rule, asks and replies; questions and answers logged verbatim |
| `packages/opencode/test/cli/log/session-log.test.ts` | End to end through the CLI against a replay server: the flag's rules (required, not needed for `--help`, relative paths, unwritable folder, `latest.log`), and that prompts, turns, retries after a 429, tool calls, refused permissions, sub-agents, forced compaction, todos, interrupts, crashes and the append-mode footer all land in the log |
| `packages/opencode/test/parity/wire.test.ts` | That the wire is unchanged with the logger in place |

The full-screen TUI has no automated test. It was checked by hand in a
pseudo-terminal against the parity replay server.
