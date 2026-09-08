# ocmini — Project Specification

A minimal Python coding agent that reproduces the working behaviour of opencode
running on a single fixed model: **Meta Muse Spark 1.3**.

Spec version 2.0 · Requirements and acceptance criteria. Design and implementation are
left open.

---

## 1. Goal

Build `ocmini`, a terminal coding agent in Python that can be used in place of opencode
for real work, with the model choice removed as a variable. Anything that could be done
by opening opencode, selecting `meta/muse-spark-1.3`, and typing a request must be
achievable with `ocmini`.

"Minimal" here means **narrow, not weak**. The project earns its simplicity by deleting
configurability — one provider, one model, one wire format, one prompt — not by deleting
capability. The test of whether a cut was correct is §7: if removing something makes an
acceptance task fail, the cut was wrong.

---

## 2. Scope

### 2.1 Required capabilities

| Capability | Notes |
|---|---|
| Interactive terminal session | Readline-grade input, streaming output |
| One-shot non-interactive run | Needed for scripting and for the acceptance harness |
| Visible tool activity | The user can see what the agent is doing as it happens |
| File reading, writing, and targeted editing | §4.1–4.3 |
| Directory listing, glob, and content search | §4.4 |
| Shell command execution | §4.5 |
| Web fetch and web search grounding | §4.6 |
| Task list tracking | §4.7 |
| Sub-agent delegation | §4.8 |
| Session persistence, listing, and resume | |
| Context compaction near the window limit | §5 |
| Permission gating for writes, shell, and network | §6 |
| Project rule loading (`AGENTS.md` or equivalent) | |
| Slash commands, including user-defined ones | |
| File checkpoints and revert | |
| Token and cost accounting | |
| Image input | Muse Spark is multimodal; screenshots and diagrams are common inputs |

### 2.2 Out of scope

Deliberately cut. None of these change *what* can be accomplished, only how comfortably.

- Multi-provider support, model picker, model catalogue.
- Full-screen TUI: panes, mouse support, themes, vim keybindings.
- LSP integration and language-aware diagnostics.
- MCP client support *(optional stretch goal — not required for completion)*.
- Share links, server mode, web UI.
- Plugin system and user-registered custom tools.
- IDE extensions.
- Orchestration beyond a single level of sub-agent delegation.

---

## 3. Fixed platform

The entire project rests on these facts about Muse Spark 1.3 and the Meta Model API.
**Verify every row against the live API before building anything else.** The model
shipped in September 2026 and public write-ups already disagree on details — notably the
base URL, where sources show both `api.meta.ai/v1` and `api.ai.meta.com/v1`.

| Property | Value |
|---|---|
| Model id | `muse-spark-1.3` |
| Provider | Meta Model API, OpenAI-SDK compatible |
| Endpoints | `/v1/responses` and `/v1/chat/completions` |
| Context window | 1,000,000 tokens |
| Max output | ~131,072 tokens |
| Input modalities | Text, image, video, PDF |
| Reasoning effort | minimal · low · medium · high · xhigh — **cannot be disabled** |
| `max` reasoning mode | Gated to partners pending safety testing; do not depend on it |
| Tool calling | Function calling, parallel calls, streamed |
| `tool_choice` | Only `auto` is reliably honoured |
| Stop sequences | Unsupported |
| Structured output | JSON-schema-guaranteed |
| Prompt caching | Supported, billed at a reduced input rate |
| Web search | Built-in server-side tool with citations |
| Pricing | $1.25 / 1M input · $0.15 / 1M cached input · $4.25 / 1M output |

Three consequences worth settling early, because each one is easy to get subtly wrong and
hard to notice afterwards:

- **Reasoning continuity.** The Responses endpoint is the only one that carries reasoning
  across turns. If reasoning state is not preserved between tool calls, everything still
  appears to work — the agent just becomes measurably worse at multi-step edits. Whatever
  approach you take, prove it with a side-by-side comparison on a five-turn task.
- **Prompt caching depends on a stable prefix.** Anything volatile near the front of the
  request (a timestamp, a changing environment block) silently forfeits the 8× discount on
  input tokens.
- **The model is trained to collaborate.** Muse Spark 1.3 asks clarifying questions on
  ambiguous prompts and confirms before consequential actions. There must be a clean path
  for a question to reach the user and an answer to return — and a defined policy for what
  happens when it asks during a non-interactive run (§7.6).

---

## 4. Tool behaviour

Requirements, not designs. Each tool needs a name, a description written for the model
rather than for humans, and a schema the model can call reliably.

**4.1 Read** — line-addressable, with offset and limit. Caps the amount returned and says
so explicitly when it truncates. Returns images as images. Refuses binaries with a clear
message rather than dumping bytes.

**4.2 Write** — creates files and parent directories, reports what changed as a diff
summary, and refuses to blindly overwrite a file the session has not read.

**4.3 Edit** — exact-match replacement of a string within a file, with an option for
replacing all occurrences. It must **fail loudly** when the target string is absent or
ambiguous, showing the nearest candidates. This error message matters more than any other
text in the system: it is the primary channel through which the model corrects itself.
Both write and edit must reject a file that changed on disk since the session last read
it, and say so in terms that tell the model to re-read.

**4.4 Search** — directory listing, glob by pattern, and content search returning
`file:line:text`. All three respect the project's ignore rules and cap their results.

**4.5 Shell** — runs a command in the session's working directory with a timeout, returns
merged output and an exit code. If shell state does not persist between calls, the system
prompt must say so; otherwise the model will assume `cd` sticks and quietly build wrong
commands.

**4.6 Network** — fetch a URL as text or markdown, with a timeout, a size cap, redirect
limits, and refusal of private and loopback addresses. Web search is exposed as the
model's built-in server-side tool rather than reimplemented locally, and returned
citations survive into the rendered output.

**4.7 Task list** — the agent can record and update a checklist of pending, in-progress,
and completed items, rendered live. Cheap to build and a large factor in whether
long-horizon runs stay on track.

**4.8 Sub-agent** — delegate a scoped question to a child run with its own context and no
ability to delegate further, returning only a final answer. This is what keeps
search-heavy exploration from flooding the main context.

**4.9 Output discipline** — every tool result is capped, and truncation is always marked
with how much was elided and how to get the rest. Every tool returns something on failure;
a dropped result breaks the next request. Silent truncation is a bug.

---

## 5. Context management

- Compaction triggers on approaching the usable window. With a million tokens this will
  rarely fire, which is the point — but one verbose test run can still blow it, so the
  path must exist and must be tested by forcing the threshold down.
- A compaction must preserve: files touched, decisions made, outstanding todos, currently
  failing tests, and any constraint the user stated. Losing user constraints during
  compaction is the failure mode that turns a long session into wasted money.
- Enough history must survive compaction for checkpoints and revert to remain coherent.

---

## 6. Permissions

Three levels per action class — allow, ask, deny — configurable and overridable per
session. Suggested defaults:

| Action class | Default |
|---|---|
| Read, list, search, task list | allow |
| Write and edit inside the working directory | ask |
| Write and edit outside the working directory | deny |
| Shell | ask, with read-only commands auto-approved |
| Network fetch | ask |

Prompts show the exact command or diff. Options: approve once, approve this pattern for
the session, or deny with a reason — and the reason is fed back to the model as the tool
result. A denial is never silent.

A blanket auto-approve flag is required for the acceptance harness. It should refuse to
run outside a version-controlled directory.

---

## 7. Definition of done

The project is complete when **T1–T4 all pass on a clean checkout, on a machine that has
never run the project before**, plus the standing conditions in §7.5.

Write the acceptance tasks and their verification scripts **before** building the tools
they exercise. Each is a directory containing a prompt, a fixture tree, and a check that
exits non-zero on failure. The verification for T1 in particular should be written blind —
graded against the prompt, not against whatever the agent happened to produce.

### 7.1 T1 — Greenfield build (the headline criterion)

**Setup:** empty directory, network available, permissions auto-approved.

**Prompt** (verbatim, single message; no follow-up except answering direct questions from
the model):

> Build a Python CLI called `tsum` that reads one or more CSV files and prints a summary
> table: for every numeric column, the count, min, max, mean, and median, rounded to 3
> decimals. Non-numeric columns report count and number of distinct values. Support
> `--column NAME` to restrict output, `--json` for machine-readable output, and reading
> from stdin when no file is given. Use only the standard library. Handle missing files,
> empty files, and ragged rows with clear error messages and non-zero exit codes. Write
> pytest tests covering all of it, and a README with usage examples. Make the tests pass.

**Pass criteria — all must hold:**

1. The produced project installs cleanly.
2. The agent's own test run exits 0.
3. **The hidden verification suite passes**: ~24 pre-written tests covering the stated
   behaviours, including three adversarial cases the prompt implies but does not spell out
   — a CSV with a byte-order mark, a column that is numeric except for one empty cell, and
   `--json` emitting valid JSON with no stray output on stdout.
4. A README exists and every command shown in it actually runs.
5. Nothing outside the working directory was modified.
6. Completed within **40 assistant turns** and **$4.00** of API spend.
7. No unhandled exception in `ocmini` itself; the run exits 0.

### 7.2 T2 — Brownfield debugging

**Setup:** a fixture repo of roughly 1,800 lines across 14 files with three seeded bugs —
a `TypeError` on a rare code path, an off-by-one in a slice, and a config default read
from the wrong key. Three tests fail. Bug locations are not mentioned in the prompt.

**Prompt:** *"Three tests are failing. Find the causes and fix them. Do not change the
tests."*

**Pass:** all tests green; test files byte-identical to the originals; the diff touches
≤ 40 lines; ≤ 30 turns; ≤ $3.00. Search and targeted reads are used to locate the bugs
rather than the whole repo being dumped into context — verifiable from the run's event log.

### 7.3 T3 — Long-horizon multi-tool task

**Setup:** empty directory, network available.

**Prompt:** *"Build a small static-site generator: read Markdown files from `content/`,
render them to HTML with a shared template, generate an index page sorted by date from
YAML front matter, and copy `static/` through. Write tests. Then create three sample posts
and build the site."*

**Pass:** the site builds; the index links all three posts in correct date order; tests
pass; the run uses sub-agent delegation or the task list at least once, showing the
long-horizon machinery is live; ≤ 60 turns; ≤ $6.00. Re-run with the compaction threshold
forced low — the task must still complete.

### 7.4 T4 — Self-hosting

Run `ocmini` against the `ocmini` repository itself:

> Add a `/stats` slash command that prints, for the current session: total turns, tool
> calls broken down by tool name, tokens in, out, and cached, and total cost. Add tests.

**Pass:** the feature works after restarting the session; new tests pass; the **entire
existing suite** still passes; ≤ 25 turns.

This is the criterion that actually matters. It demonstrates the tool is good enough to
maintain itself, which is the same bar as "good enough to use instead of opencode."

### 7.5 Standing conditions

- Unit and integration suites green, with meaningful coverage of the agent loop, tool
  execution, permission decisions, and compaction.
- `--help` and the README describe every flag and command that exists, and nothing that
  does not.
- **Three consecutive T1 runs pass.** A one-in-three success rate is not a passing agent,
  it is a lucky one. When T1 is flaky, the cause is almost always tool error messages or
  the system prompt rather than the loop itself.
- No lost session on crash: killing the process mid-turn and resuming recovers the
  conversation and leaves the working tree in a recoverable state.

### 7.6 Non-interactive question policy

Muse Spark 1.3 will sometimes ask rather than proceed. Define one policy and hold to it:
the question is surfaced, the run continues with an instruction to use best judgement, and
a run that stalls waiting for input counts as a **failure** of whichever acceptance task it
occurred in. An agent that hangs unattended is not finished.

### 7.7 Parity check (report, not a gate)

Run T1–T3 under real opencode with `meta/muse-spark-1.3` and record turns, cost, and
wall-clock time. `ocmini` is expected to be worse; document the gap with a one-line cause
for each. If `ocmini` fails a task opencode passes, that is a defect against this spec —
amend the spec, then fix the code.

---

## 8. Suggested phasing

Not binding, but each phase ends with a gate worth having.

| Phase | Deliverable | Gate |
|---|---|---|
| 1 | API spike: one streamed call with one tool | Every row of §3 confirmed or corrected in this document; parallel tool calls observed live |
| 2 | Model calls, streaming, session persistence | Reasoning continuity proven across a multi-turn tool conversation |
| 3 | Read-only tools inside a working loop | Agent can answer questions about a codebase without writing anything |
| 4 | Write, edit, shell, permissions | **T1 passes** |
| 5 | Interactive session, rendering, abort, slash commands, cost display | A 20-minute session with no crash; abort works mid-command |
| 6 | Checkpoints, revert, resume | Kill mid-turn, resume, revert restores the tree exactly |
| 7 | Compaction, task list, sub-agents, project rules | **T2 passes**; forced-threshold compaction test passes |
| 8 | Network tools, images, machine-readable output | **T3 passes** |
| 9 | Hardening: error text, retries, truncation, docs | **T4 passes**; §7.5 satisfied |

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Wire format differs from §3 | Phase 1 exists for exactly this; nothing else starts first |
| Reasoning continuity handled wrong → quietly weaker agent | Explicit phase-2 gate comparing with and against |
| Vague edit-failure messages → the agent flails and burns turns | Treat tool error text as a product surface; T2 detects it |
| Acceptance tasks drift toward what the code already does | Write the verification blind, before the tools exist |
| Development cost overruns | Lower reasoning effort for routine work, reserve high and xhigh for acceptance runs and hard debugging |
| Prompt-cache misses from a volatile prefix | Assert prefix stability in tests; watch cached-token counts in the cost display |
