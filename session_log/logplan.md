# Plan: per-session logs

Every ocmini session writes one human-readable log file that records everything that
happened in it: what was sent to the model, what came back, which tools ran and what they
returned, what the user was asked and answered, and everything that went wrong along the
way. When a run misbehaves, this file should answer "why?" without re-running it.

## Why this belongs in a stripping project

Almost everything in ocmini is a deletion, and this is an addition, so it needs a reason.
The spec already asks for it in pieces, with nowhere to put them:

- §3 wants a "logging shim around the fetch" to capture real request/response pairs.
- §3.1 wants the resolved model id logged on every acceptance run.
- §7.2 grades T2 on whether search and targeted reads were used, "verifiable from the
  run's event log". That log does not exist yet.
- §7.7 wants every question and answer "recorded verbatim in the run log", plus a question
  count.
- §3 and §9 warn that broken reasoning continuity and rate-limit stalls are silent. A raw
  wire log is how they become visible.

This work builds that log. It does not replace or remove `opencode.log` or the
`OPENCODE_DIRECT_TRACE` trace. Whether to cut those once this exists is a separate
decision (see the end of this file).

## Decisions

| Question | Decision |
|---|---|
| Format | Human-readable text, split into blocks with headers you can grep |
| Detail | Everything raw: the full request body on every call and every streamed SSE event as it arrived |
| Location | The folder given by `--log-dir <folder>`, a **required** command-line flag. `bun dev` won't start a session without it |
| Retention | Kept forever. Nothing prunes the logs automatically |
| Enabled | Always on. There is no off switch, because every session has to be given a log folder |
| Scope | One file per process, which is one session: nothing starts a second session in one process. Sub-agents, title generation and compaction calls go into the same file, tagged by who made them |
| Redaction | Secrets are scrubbed everywhere in the file: headers, request bodies, SSE events and tool output (details below) |
| Path shown | Never printed, by `run` or by the TUI. Find the file through `latest.log` |

The details behind those decisions:

- **The `--log-dir` flag.** It is a global option in `src/index.ts`, next to
  `--print-logs` and `--log-level`. `bun dev` runs `src/index.ts` and passes its
  arguments through, so it needs no `package.json` change:

  ```bash
  bun dev --log-dir ~/ocmini-logs .                     # interactive
  bun dev run --log-dir ~/ocmini-logs "fix the tests"   # one-shot
  ```

  - **Where it's required.** Every command that can start a session: the default TUI
    command, `run`, and `serve` while it still exists. `--help`, `--version`,
    `completion` and `generate` work without it, so you can always find out that the flag
    exists.
  - **If it's missing,** ocmini prints `--log-dir is required` with usage and exits
    non-zero before it does anything else. There is no default folder.
  - **Relative paths** resolve against the directory you typed `bun dev` in
    (`process.env.PWD`). They do not resolve against `packages/opencode`, where
    `bun dev`'s `--cwd` puts the process. That is the same rule `run.ts` and `tui.ts`
    already use for the project directory.
  - **Folder checks at startup.** The folder is created if it doesn't exist. If it can't
    be created or written to, ocmini exits at startup with the path and the reason.
  - **Handing it to the TUI.** The log file's path (not just the folder) is passed to the
    TUI's worker thread the same way `--print-logs` becomes `OPENCODE_PRINT_LOGS`: the
    middleware sets it in the environment, with the pid, so a child process that inherits
    the environment doesn't write to it. The flag is still the only supported way to set it.
- **File name** is `<UTC timestamp>-<pid>.log`, e.g. `20260926T140311Z-48213.log`. The file
  opens at process start, before a session id exists, so startup failures (no API key, bad
  config) get logged too. The session id is written in a `SESSION` block once the session
  exists, since blocks are only ever appended.
- **`latest.log`** is a symlink in the log folder that always points at the newest file
  in that folder. Since ocmini never prints the path, this is how you find the current log.
  If you use different folders for different runs, each folder has its own `latest.log`.
- **Redaction.** Every line passes through one scrubber just before it is written, so
  every block kind gets the same treatment. It only changes the logged copy; the bytes on
  the wire are never touched. It masks:
  - auth headers (`Authorization`, `x-api-key`) and any header or query parameter named
    like a key, token or secret
  - the literal value of the configured zen API key, and of every environment variable
    whose name contains `KEY`, `TOKEN`, `SECRET` or `PASSWORD`, wherever it appears
    (collected once at startup)
  - well-known token shapes: `sk-…`, `ghp_…` / `github_pat_…`, `xox?-…`, `AKIA…`, JWTs,
    and `-----BEGIN … PRIVATE KEY-----` blocks
  - `.env`-style assignments (`NAME=value` where the name looks like a secret), with the
    name kept and the value masked

  A masked value becomes `[redacted:<kind> …last4]`, so you can still tell two secrets
  apart. There is no generic high-entropy detection. It would hit the model's
  `encrypted_content` and hashes all over the place. The cost of scrubbing is that the log
  no longer matches the wire byte for byte wherever a secret was masked.

## What gets logged

Each item below is one kind of block in the file.

### 1. Session header (once, at the top)

- ocmini version, git commit of the build, pid, argv, cwd, platform, Bun version
- Start time, and the resolved log folder and file name
- Session id, filled in once known
- Resolved provider, base URL, **model id** (§3.1), and whether it ends in
  `-contributor-free`
- LLM runtime selected (`ai-sdk` or `native`) and why, if native fell back
- Reasoning effort and max output tokens
- Permission mode (normal, or the blanket auto-approve flag) and the effective rule set
- Config files loaded, `AGENTS.md` / instruction files loaded, and skills discovered
- Tools registered for the agent, by name. Full schemas show up in the first request body

### 2. User input

- Every prompt the user submits, verbatim, with its turn number

### 3. Model requests (raw HTTP)

Every HTTP call to the provider, including auxiliary ones, is logged, not just agent turns.

- Sequence number (`REQUEST #n`), turn number, and scope (`main`, `sub#1 explore`, …)
- Purpose: agent turn, title generation, compaction summary, or something else
- Method, full URL, and all request headers (redacted as above)
- Full request body, pretty-printed JSON: instructions/system prompt, the complete input
  history (including reasoning items and `encrypted_content`), tool schemas,
  `previous_response_id` / `store`, reasoning effort, and any other parameters
- Byte size of the body

### 4. Model responses (raw HTTP)

- Status line and all response headers, especially request id, rate-limit and
  `retry-after` headers
- Time to first byte
- **Every raw SSE event** as received, one line each, with time offset from the request
- An **end-of-response summary** assembled from the stream:
  - total duration and finish reason
  - response id
  - text output, reasoning summary (if any), and the size of the encrypted reasoning
  - tool calls the model asked for: name, call id, arguments
  - usage: input, cached input, output, reasoning tokens, and running session totals
- Non-streaming error responses are logged with the full body

### 5. Errors, retries and rate limits

- HTTP errors with status and full body, including 429 `FreeUsageLimitError` and the 500
  a wrong endpoint returns
- Each retry: attempt number, the error that caused it, the backoff chosen, and when the
  next attempt fires
- Stream failures: chunk timeouts, header timeouts, aborts (user-initiated or not), and
  truncated streams
- Uncaught exceptions and unhandled rejections in ocmini itself, with stack traces
- Warnings and errors from the existing Effect logger (`Effect.logWarning`/`logError`), so
  internal problems also show up next to the requests that caused them

### 6. Tool calls

- Sequence number (`TOOL #n`), call id, tool name, and scope
- Arguments, pretty-printed
- Permission check: the permission and pattern asked for, the rule that matched, and the
  outcome (allowed by rule, asked, or denied by rule)
- If the user was asked: what they saw (command or diff), their choice (once, always for
  this pattern, or deny) and any deny reason, plus how long they took
- Start time, duration, and whether it finished, errored or was aborted
- **The output exactly as returned to the model**, plus truncation info (whether it was
  truncated, the original size, and where the full output was saved)
- Tool-level errors, including invalid arguments and unknown tool names the model made up
- Edit/write side effects that affect the next turn: formatter run (which, exit status) and
  LSP diagnostics appended to the output

### 7. Questions to the user (§7.7)

- The question, the options offered, and the recommended option, verbatim
- The answer, verbatim, and how long it took
- Timeout aborts
- A running question count

### 8. Sub-agents

- Start: parent tool call id, agent name, child session id, the prompt it was given, and
  its narrowed permissions
- All of its requests, responses and tool calls, tagged with its scope
- End: its final result as returned to the parent, and its turn and token totals

### 9. Context management

- Overflow checks that fire: current token count, the usable window and the threshold
- Tool-output erasure: which call ids had their output erased and how many tokens that
  freed
- Compaction: start, the request/response for the summary (logged as §3/§4 with purpose
  `compaction`), the summary produced, and token counts before and after
- Todo list changes (full list after each write) and reminders injected into context

### 10. Turn and session boundaries

- `TURN n START` / `TURN n END` markers with running totals of turns and tokens (input,
  cached, output, reasoning) and tool calls
- **Session footer**, written on normal exit, abort (Ctrl-C), or crash where possible:
  - exit reason and exit code
  - wall-clock time, with time spent waiting on the user or on rate limits listed separately
  - total turns, total tokens by category, total requests, retries and 429s
  - tool call counts by tool, denials, questions asked
  - compactions run

  These are the numbers §7 grades on, so the log is enough to score a run.

## File format

Plain text. Every block starts with a header line in this shape:

```
[HH:MM:SS.mmm +elapsed] ── KIND #n ── scope · extra
```

Everything under the header, up to the next header, belongs to that block, indented two
spaces. JSON bodies are pretty-printed. SSE events are one line each and not reformatted,
so they look exactly as they arrived. `grep '── REQUEST'`, `grep '── TOOL'`, and so on
list each kind of block.

A short example (bodies elided here, never in the real file):

```
════════ ocmini session log ════════
  started    2026-09-26T14:03:11.204Z
  ocmini     1.4.2 (a413897)   pid 48213   bun 1.3.1   darwin arm64
  cwd        /Users/me/work/tsum
  log dir    /Users/me/ocmini-logs
  argv       run "Build a Python CLI called tsum…"
  model      opencode/muse-spark-1.3-contributor-free   ✓ contributor-free
  base url   https://opencode.ai/zen/v1
  runtime    ai-sdk
  reasoning  medium   max output 131072
  perms      auto-approve (--yes)
  rules      AGENTS.md (1 file)   skills 3   tools 13
  session    ses_01JB8…

[14:03:11.910 +0.706s] ── USER PROMPT ── main · turn 1
  Build a Python CLI called `tsum` in a new folder `tsum` that reads …

[14:03:11.932 +0.728s] ── REQUEST #1 ── main · turn 1 · purpose agent
  POST https://opencode.ai/zen/v1/responses   (38,114 bytes)
  headers
    authorization: Bearer [redacted:api-key …3f9a]
    content-type: application/json
    user-agent: opencode/1.4.2
  body
    {
      "model": "muse-spark-1.3-contributor-free",
      "store": false,
      "reasoning": { "effort": "medium" },
      "input": [ … ],
      "tools": [ … ]
    }

[14:03:13.140 +1.936s] ── RESPONSE #1 ── main · turn 1 · 200 OK · ttfb 1.208s
  headers
    x-request-id: req_8c1…
    x-ratelimit-remaining: …
  stream
    +1.208 event: response.created
    +1.208 data: {"type":"response.created","response":{…}}
    +1.244 data: {"type":"response.reasoning_summary_text.delta",…}
    …
  summary · 4.53s · finish tool_calls · resp_0a1…
    text        (none)
    reasoning   312 chars summary · encrypted 9,840 bytes
    tool calls  read call_01 {"filePath":"/Users/me/work/tsum/README.md"}
    usage       in 9,204 · cached 0 · out 812 (reasoning 640) · session 10,016

[14:03:15.702 +4.498s] ── TOOL #1 ── main · turn 1 · read call_01
  args        {"filePath":"/Users/me/work/tsum/README.md"}
  permission  read /Users/me/work/tsum/README.md → allow (rule: read *)
  result      error · 3ms
  output
    File not found: /Users/me/work/tsum/README.md

[14:05:40.017 +148.8s] ── RETRY ── main · turn 7 · attempt 2
  cause    429 FreeUsageLimitError  {"error":{…}}
  backoff  retry-after 3600s → next attempt 15:05:40
…
════════ session end ════════
  exit        completed (0)   wall 18m42s (waiting: user 0s, rate limit 0s)
  turns       31   requests 33 (2 aux)   retries 0
  tokens      in 1,104,220 · cached 880,112 · out 41,907 (reasoning 30,118)
  tools       read 14 · edit 9 · write 6 · shell 11 · glob 2 · grep 3
  questions   0   denials 0   compactions 0
```

## Where it hooks in

A new module, `packages/opencode/src/session/log.ts`, owns the file. It follows
`src/cli/cmd/run/trace.ts`: a lazily opened file handle, synchronous writes
(`fs.writeSync` on one fd), and no Effect service. Synchronous writes mean the log gets
everything up to a crash or kill, which is when it's needed most. It exposes one function
per block kind (`request`, `responseEvent`, `responseEnd`, `tool`, `question`, …) plus a
scope context.

**Scope and purpose context.** The fetch wrapper can't see which session or sub-agent
made a call. `llm.ts` sets a small AsyncLocalStorage context (`src/util/local-context.ts`
already wraps one) with session id, scope label, turn and purpose before starting the
stream, and the fetch hook reads it.

| What | Hook point |
|---|---|
| `--log-dir` flag, folder check, enforcement | Global option and middleware in `src/index.ts`, required on the TUI, `run` and `serve` commands |
| Header, footer, crash handler | CLI entry (`src/index.ts`, `src/cli/cmd/run.ts`, `src/cli/cmd/tui.ts`), `process.on("exit" / "uncaughtException" / "unhandledRejection" / "SIGINT")` |
| Resolved model, runtime choice | `src/session/llm.ts` around the runtime seam (it already logs `llm runtime selected`) |
| Raw request + response (ai-sdk path) | The `options["fetch"]` wrapper in `src/provider/provider.ts` (~L1748). Log the request, then hand the SDK a pass-through body: each chunk is logged as the SDK reads it, then passed on unchanged. The logger never reads ahead, so nothing is buffered for a reader that stops early |
| Raw request + response (native path) | `providerFetch` in `src/session/llm/native-runtime.ts`, wrapped the same way. Only used behind `experimentalNativeLlm` |
| Response summary, usage | `src/session/processor.ts`, where LLM events (finish, usage, tool-call) are already consumed |
| Retries, 429s | `src/session/processor.ts` retry block (~L604) and `src/session/retry.ts` |
| Tool calls, args, output, duration | `execute` in `src/session/tools.ts` (~L77), plus the processor's tool-error path for invalid or unknown calls |
| Truncation details | `src/tool/truncate.ts` result metadata, read at the tools.ts hook |
| Permission asks and decisions | `src/permission/index.ts` (ask + reply) |
| Questions and answers | `src/question/index.ts` (ask + reply) |
| Sub-agent start/end | `src/tool/task.ts` |
| User prompt, turn boundaries | `src/session/prompt.ts` loop |
| Overflow, erasure, compaction | `src/session/overflow.ts`, `src/session/compaction.ts` |
| Todo updates, reminders | `src/session/todo.ts`, `src/session/reminders.ts` |
| Effect warnings/errors | One extra `Logger` in `core/src/observability/logging.ts`'s `loggers()`, filtered to Warn and above, that forwards to the session log |

## Guarantees

- **The wire doesn't change.** The logger only reads. It never changes the request or
  consumes the stream the SDK reads. The existing wire-parity test
  (`test/parity/`) must stay green, and that is the proof.
- **Logging never breaks a session.** Every write is wrapped. On the first failure (disk
  full, permission denied) ocmini prints one warning to stderr, stops logging, and carries
  on.
- **ocmini writes session logs only to the folder you name.** If that folder is inside the
  working tree, the logs will show up in `git status`, and that's your call. The acceptance
  harness must pass a folder outside the task's copy of the fixture. Otherwise §7.1's
  "nothing outside the working directory" check and §7.4's check for pre-existing files
  would see the log files.
- **Secrets are scrubbed on a best-effort basis.** Pattern matching can't catch every
  secret, and the file still holds every prompt and every file the agent read. Treat it as
  sensitive even after scrubbing.

## Size

"Everything raw" plus "keep forever" makes the logs big. The Responses API resends the
whole conversation, including encrypted reasoning, on every turn, so total request bytes
grow roughly with the square of the turn count. SSE adds an envelope of about 100–200
bytes per delta. Rough estimates:

- a short interactive session: well under 1 MB
- a T1-sized run (~30–40 turns): roughly 5–20 MB
- a T3-sized run (~60 turns): tens of MB

Nothing is pruned, so the log folder grows with every run. If that
becomes a problem, options include a prune-by-count setting or logging the unchanged prefix
of `input` by reference after the first request. Neither is in this plan.

## Implementation steps

Each step is one commit on `master`.

1. **`--log-dir` and the `session/log.ts` core.** Add the required flag, the startup check
   on the folder, file creation, header/footer, block formatting, the secret scrubber,
   the `latest.log` symlink, and write-failure handling. Every test that spawns
   `src/index.ts` needs `--log-dir` pointing at a temp folder in the same commit, or
   `bun test` goes red. That means the shared helper `test/lib/cli-process.ts` and the
   direct spawns in `test/parity/wire.test.ts` and the others. Tests:
   - A command without `--log-dir` exits non-zero with the message.
   - `--help` and `--version` still work without it.
   - A relative `--log-dir` resolves against `PWD`.
   - An unwritable folder fails at startup.
   - Unit tests cover formatting.
   - A scrubber test table covers each token shape, env values, `.env` lines, a private
     key block, and an `encrypted_content` blob that must come through unchanged.
2. **Wire capture.** Fetch hook in `provider.ts` (and the native path), the
   AsyncLocalStorage scope context set in `llm.ts`, raw request and SSE stream logging.
   Test: run the wire-parity replay with a fake API key, and a secret-shaped string planted
   in the prompt. Check that the log has the request and every event from
   `muse-spark-response.txt`, that neither the key nor the planted string appears in it,
   and that the parity assertion (what went over the wire) still passes unchanged.
3. **Response summaries and turn accounting.** Processor hook: finish reason, usage,
   running totals, turn markers, session footer totals.
4. **Tools, permissions, questions.** Hooks in `tools.ts`, `permission/`, `question/`.
   Test: a replayed exchange that makes a tool call produces a matching `TOOL` block with
   args, permission outcome and output.
5. **Retries, errors, crashes.** Retry/429 blocks, uncaught-exception handler, Effect
   Warn+ forwarding. Test: a replay server that returns 429 then 200 produces a `RETRY`
   block.
6. **Sub-agents and context management.** Scope tags for `task.ts` children, plus
   overflow, erasure, compaction, todo and reminder blocks. Test: force the compaction
   threshold low (as §7.3 already requires) and check that the compaction block appears.
7. **Document it.** The README and `--help` describe `--log-dir` as required (§7.5 wants
   every flag documented). Add a README section on what goes in the folder, `latest.log`,
   what gets scrubbed and what doesn't, and the training-rights caveat: apart from masked
   secrets, the file holds exactly what zen saw. Update the acceptance-run instructions to
   pass a log folder outside the task directory.

## As built

Implemented in the commits after `e0a609817e` on `master`. Where the build
differs from the plan above:

- **Steps became commits** like this: 1 (flag and module, including the crash
  and signal handling from step 5), 2 (wire capture), 3 with step 5's retries
  (turns, summaries, retries; they share the processor), 4 (tools, permissions,
  questions), a prettier-only commit, 6 (sub-agents and context management), the
  rest of step 5 (interrupt and crash tests), and 7 (this section and the
  README). Two bugs were found and fixed along the way. The TUI's footer
  overwrote the worker's blocks, because the log was opened non-append. A
  rethrown unhandled rejection was logged twice.
- **More block kinds than listed.** `SESSION` (id, parent, scope label),
  `MODEL` (once per session and agent: model id with the `-contributor-free`
  check, base URL, runtime, provider options such as `store`/`include`/
  reasoning effort, max output), `AGENT` (tools offered, permission rules),
  `CONTEXT` (instruction files, skills), `CONFIG` (each config source loaded),
  and `LOG WARN`/`LOG ERROR` (forwarded from the Effect logger).
- **A response is written as two blocks.** `RESPONSE #n` holds the raw exchange
  and is written when the body finishes, errors or is cancelled. That keeps
  concurrent streams (the title call runs alongside the first turn) from
  interleaving. A response still streaming at exit or crash is flushed and
  marked unfinished. `RESPONSE #n SUMMARY` holds the processor's view: text,
  reasoning, tool calls, finish, usage.
- **Permission checks are their own blocks** (`PERMISSION`, `PERMISSION REPLY`),
  written chronologically between a tool's `TOOL #n` and `TOOL #n END`, rather
  than folded into the tool block. A tool's metadata values over 1,000 characters
  (whole before/after file contents) are shown by size. The output the model
  saw is always in full. Permission asks show what the user saw in full.
- **Turns are numbered by agent turns**, not prompt-loop iterations. A loop pass
  that only runs compaction or a queued subtask is not a turn.
- **Log state is tied to the file path.** Numbering, scopes, totals and the
  failure flag reset if the path changes. A real run never changes it; tests,
  which share one process, rely on it.
- **Signals.** On SIGINT/SIGTERM/SIGHUP with no other handler, the footer is
  written and the signal re-raised, so the process still dies the way it would
  have. When something else handles the signal, as the interactive run loop
  does for Ctrl-C, the log only notes it.
- **Not covered by an automated test:** the full-screen TUI. It was checked by
  hand, driving it in a pseudo-terminal against the parity replay server. The
  append-mode regression test covers the part of it that broke.

## Not in this plan

- Pruning or rotation (you chose keep forever)
- A viewer command or JSON output
- Cutting `opencode.log` or `src/cli/cmd/run/trace.ts`. Once this log exists, the direct
  trace mostly overlaps with it and is a good candidate for a later cut. That cut should
  be its own commit with its own reason.
