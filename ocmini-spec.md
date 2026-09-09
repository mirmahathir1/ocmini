# ocmini — Project Specification

A minimal Python coding agent that reproduces the working behaviour of opencode
running on a single fixed model: **Muse Spark 1.3 Contributor Free**, served by opencode
zen. The Contributor Free variant — not the paid Muse Spark 1.3 listing — is the target,
and that choice carries conditions on both cost and confidentiality (§3.1).

---

## 1. Goal

Build `ocmini`, a terminal coding agent in Python that can be used in place of opencode
for real work, with the model choice removed as a variable. Anything that could be done
by opening opencode, selecting `opencode/muse-spark-1.3-contributor-free`, and typing a
request must be achievable with `ocmini`.

"Minimal" here means **narrow, not weak**. The project earns its simplicity by deleting
configurability — one provider, one model, one wire format, one prompt — not by deleting
capability. The test of whether a cut was correct is §7: if removing something makes an
acceptance task fail, the cut was wrong.

---

## 2. Scope

### 2.1 Required capabilities

| Capability | Notes |
|---|---|
| Interactive terminal session | Readline-grade input |
| One-shot non-interactive run | Needed for scripting and for the acceptance harness |
| Visible tool activity | The user can see what the agent is doing as it happens |
| File reading, writing, and targeted editing | §4.1–4.3 |
| Directory listing, glob, and content search | §4.4 |
| Shell command execution | §4.5 |
| Web fetch and web search grounding | §4.6 |
| Task list tracking | §4.7 |
| Sub-agent delegation | §4.8 |
| Context compaction near the window limit | §5 |
| Permission gating for writes, shell, and network | §6 |
| Project rule loading (`AGENTS.md` or equivalent) | |
| Token and quota accounting | Tokens, including reasoning tokens, and remaining-quota signals; tokens are free on this tier (§3) so the display is denominated in tokens, not dollars |

### 2.2 Out of scope

Deliberately cut.

- Multi-provider support, model picker, model catalogue. One base URL, one key, one
  model id in configuration (§3.1) is not provider abstraction and does not reopen this.
- Full-screen TUI: panes, mouse support, themes, vim keybindings.
- LSP integration and language-aware diagnostics.
- MCP client support *(optional stretch goal — not required for completion)*.
- Share links, server mode, web UI.
- Plugin system and user-registered custom tools.
- IDE extensions.
- Orchestration beyond a single level of sub-agent delegation.
- Slash commands, built-in or user-defined. The agent is driven by natural-language
  prompts alone; anything a command would have exposed is either a CLI flag or nothing.
- Session persistence, listing, and resume. Each run starts with an empty conversation and
  keeps it in memory only.
- File checkpoints and revert. The working tree is protected by version control, not by
  ocmini.
- Image input. Muse Spark 1.3 accepts images, but ocmini sends text only.
- Parallel tool calls. The model supports them; ocmini executes one tool call per
  turn, sequentially, and a response requesting several is handled one at a time.

---

## 3. Fixed platform

The entire project rests on these facts about Muse Spark 1.3 **Contributor Free** and the
opencode zen API. Zen lists two Muse Spark 1.3 variants; ocmini targets the Contributor
Free one, and every figure below is that variant's.

**Verify every row against the live API before building anything else** — the figures below
were taken from opencode zen's published documentation and third-party write-ups in
September 2026, and they already disagree with each other in places, mostly because the
free tier launched on 2 September 2026 and is still moving.

| Property | Value |
|---|---|
| Variant | **Contributor Free** — the free tier, not the paid Muse Spark 1.3 listing |
| Model id | `muse-spark-1.3-contributor-free`, addressed in config as `opencode/muse-spark-1.3-contributor-free` |
| Provider | opencode zen, sole runtime provider (the model itself is Meta's) |
| Base URL | `https://opencode.ai/zen/v1` |
| Auth | opencode zen API key from the environment |
| Endpoints | `/responses` — **required**, see below; `/chat/completions` is not available for this model |
| Context window | 1,048,576 tokens |
| Max output | 131,072 tokens |
| Input modalities | Text, image, and more — ocmini uses text only (§2.2) |
| Reasoning effort | minimal · low · medium · high · xhigh |
| Tool calling | Function calling, parallel calls — ocmini uses one call at a time (§2.2) |
| Structured output | JSON-schema-guaranteed |
| Prompt caching | Supported, at zero cost on this tier |
| Web search | **Unconfirmed** — see §4.6 |
| Pricing | Free: $0 input · $0 cached · $0 output, in exchange for training rights (§3.1) |

Four consequences worth settling early, because each one is easy to get subtly wrong and
hard to notice afterwards:

- **This tier is Responses-API only.** Calls to the chat-completions path are reported to
  return HTTP 500 — a wrong-endpoint error dressed as an outage, which will cost an
  afternoon if it is not expected. Build on `/responses` from the first spike.
- **Reasoning continuity requires the Responses endpoint.** Reasoning state carries across
  turns either by `previous_response_id` or, with `store: false`, by passing back the
  reasoning items' `encrypted_content`; the guidance for OpenAI-compatible Responses
  implementations is to return the reasoning items alongside each function-call result.
  Get this wrong and everything still appears to work — the agent just becomes measurably
  worse at multi-step edits. Prove continuity with a side-by-side comparison on a
  five-turn task, and confirm during phase 1 which of the two mechanisms zen actually
  honours, since `store` semantics on a proxied endpoint are not guaranteed to match
  OpenAI's.
- **Rate limits, not cost, are the binding constraint.** There is no published free quota.
  Reports describe `FreeUsageLimitError` over HTTP 429 arriving after unpredictable
  durations — one estimate puts the daily allowance near thirty cents of equivalent value
  — with multi-hour retry windows rather than instant resets. This inverts the usual
  budget argument: §4.9's output caps and §5's early compaction are still right, but they
  are there to protect *turns and tokens against the quota*, not dollars.
- **Reasoning tokens consume the context budget** even though they are never displayed,
  and they count against output limits and quota. Context accounting that ignores them
  will understate the window. Effort remains the main lever in §9's overrun mitigation —
  now measured in quota exhaustion rather than spend.

### 3.1 The free tier is dated; the wire format is not

Three of the rows above are dated facts rather than stable ones, and all are cheap to fix
if they move.

- **Free is promotional and conditional.** The Contributor tier buys free tokens with
  permission to use prompts and completions to train future Meta models. That is a
  material constraint on what ocmini may be pointed at: acceptance fixtures and
  open-source work are fine, and anything proprietary or client-owned is not. Say so in
  the README rather than burying it here. The tier joined on 2 September 2026 with no
  stated end date, and is reported to rotate or throttle without notice.
- **The exact model id must be confirmed against the live API.** Sources disagree on
  whether the version is dotted (`muse-spark-1.3-contributor-free`) or hyphenated
  (`muse-spark-1-3-contributor-free`). Resolve this in phase 1 and record the resolved id
  in the run log. Whichever spelling is correct, it must carry the `-contributor-free`
  suffix: the bare `muse-spark-1.3` id is the paid listing, and silently landing on it
  turns a free run into a billed one. Assert the configured id ends in
  `-contributor-free` at startup, and log the resolved id on every acceptance run.
- **The free pool can vanish.** Because the provider is one base URL, one key, and one
  model id (below), falling back to the paid Muse Spark 1.3 listing or another zen model
  is a configuration change, not a code change. Keep it that way.

The provider is one base URL, one key, and one model id read from configuration. Nothing
else in the agent may assume opencode zen specifically — not because a second provider is
planned (§2.2 cuts that), but because this is what keeps a tier change, an alias move, or
a repricing to a one-line change.

---

## 4. Tool behaviour

Requirements, not designs. Each tool needs a name, a description written for the model
rather than for humans, and a schema the model can call reliably.

**4.1 Read** — line-addressable, with offset and limit. Caps the amount returned and says
so explicitly when it truncates. Refuses binaries — images included — with a clear message
rather than dumping bytes.

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
limits, and refusal of private and loopback addresses. Web search grounding is **not
confirmed available** on this model and tier: no server-side search tool is documented for
it. Establish in phase 1 whether one exists. If it does, expose it as the model's built-in
tool rather than reimplementing it, with citations surviving into the rendered output; if
it does not, satisfy §2.1's search requirement with a search-API-backed local tool behind
the same §6 network permission, and record the decision here.

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
- Compaction is the only history-shortening mechanism; there is no checkpoint to fall back
  on, so a compaction that drops something is unrecoverable.

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

T4's fixture already exists at `fixtures/t4-taskbook/` and is committed to this repository.
It is a working application with a green test suite, not a sketch: keep it that way, and
run every acceptance attempt against a copy.

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
6. Completed within **40 assistant turns** and **1.5M total tokens**, counting reasoning
   tokens as the output they are. Tokens are free on this tier (§3), so the budget is
   denominated in tokens and turns; a 429 pause does not count against wall-clock, but a
   run that cannot finish inside the quota is still a failure.
7. No unhandled exception in `ocmini` itself; the run exits 0.

### 7.2 T2 — Brownfield debugging

**Setup:** a fixture repo of roughly 1,800 lines across 14 files with three seeded bugs —
a `TypeError` on a rare code path, an off-by-one in a slice, and a config default read
from the wrong key. Three tests fail. Bug locations are not mentioned in the prompt.

**Prompt:** *"Three tests are failing. Find the causes and fix them. Do not change the
tests."*

**Pass:** all tests green; test files byte-identical to the originals; the diff touches
≤ 40 lines; ≤ 30 turns; ≤ 1M total tokens. Search and targeted reads are used to locate the bugs
rather than the whole repo being dumped into context — verifiable from the run's event log.

### 7.3 T3 — Long-horizon multi-tool task

**Setup:** empty directory, network available.

**Prompt:** *"Build a small static-site generator: read Markdown files from `content/`,
render them to HTML with a shared template, generate an index page sorted by date from
YAML front matter, and copy `static/` through. Write tests. Then create three sample posts
and build the site."*

**Pass:** the site builds; the index links all three posts in correct date order; tests
pass; the run uses sub-agent delegation or the task list at least once, showing the
long-horizon machinery is live; ≤ 60 turns; ≤ 2.5M total tokens. Re-run with the compaction threshold
forced low — the task must still complete.

### 7.4 T4 — Feature work in an existing codebase

The only task where the agent modifies code it did not write. T1 and T3 are greenfield and
T2 is bug-fixing; neither exercises adding a feature that has to fit conventions already
in the repository.

**Setup:** a copy of `fixtures/t4-taskbook/` — a working 350-line task-tracker CLI over
five modules, with a 45-test suite that is **green before the run**. Standard library
only, no install step. Copy it to a scratch directory; never run the task against the
fixture in place, or a failed run leaves the fixture dirty for the next one.

Confirm the starting state before grading anything:

    python -m unittest discover -s tests -t .    # 45 tests, OK

**Prompt** (verbatim, single message):

> Add due dates to taskbook. `add` takes an optional `--due YYYY-MM-DD`; a new `due`
> command sets or clears the due date on an existing task. Due dates show in the task
> listing, and overdue tasks are visibly marked. `list` takes `--overdue` to show only
> tasks that are past due. Sorting puts overdue tasks first, then tasks due soonest, and
> tasks with no due date last — all still within the existing open-before-done ordering.
> Update the README and add tests.

**Pass criteria — all must hold:**

1. The feature works end to end from the command line.
2. **The 45 pre-existing tests still pass, unmodified.** Any edit to a file under `tests/`
   that existed before the run is a failure, whatever the reason. The suite is the
   regression contract; an agent that "fixes" a failing test by changing the test has
   failed the task.
3. New tests cover the feature and pass.
4. The hidden verification suite passes — roughly 15 tests over the stated behaviour plus
   four cases the prompt implies but does not spell out: a malformed `--due` value exits
   non-zero with a readable message rather than a traceback; a task due today is not
   overdue; a completed task is never reported overdue however old its due date; and a
   store written before this feature existed still loads, its tasks simply having no due
   date.
5. Conventions are followed rather than worked around — user-facing failures raised as
   `TaskError`, rendering returning strings rather than printing, the new subcommand
   registered the way the others are. Graded by reading the diff.
6. `README.md` documents the new flag and command, and every command shown in it runs.
7. ≤ 25 turns and ≤ 1M total tokens.

Point 4 is the part that separates a real implementation from a plausible one, and point 2
is the part that catches an agent taking the easy way out.

### 7.5 Standing conditions

- Unit and integration suites green, with meaningful coverage of the agent loop, tool
  execution, permission decisions, and compaction.
- `--help` and the README describe every flag that exists, and nothing that does not.
- **Three consecutive T1 runs pass.** A one-in-three success rate is not a passing agent,
  it is a lucky one. When T1 is flaky, the cause is almost always tool error messages or
  the system prompt rather than the loop itself.
- Killing the process mid-turn leaves the working tree in a state version control can
  explain: no half-written files, no orphaned temporary artefacts. The conversation is
  lost by design, and that is acceptable.

### 7.6 Non-interactive question policy

A reasoning model will sometimes ask rather than proceed — Muse Spark 1.3 is expected to
do this on ambiguous prompts and before consequential actions. Define one policy and hold to it:
the question is surfaced, the run continues with an instruction to use best judgement, and
a run that stalls waiting for input counts as a **failure** of whichever acceptance task it
occurred in. An agent that hangs unattended is not finished.

### 7.7 Parity check (report, not a gate)

Run T1–T3 under real opencode with `opencode/muse-spark-1.3-contributor-free` — the same
provider and model this project targets, which makes the comparison a clean test of the harness rather than of the
model — and record turns, tokens, and wall-clock time. `ocmini` is expected to be worse;
document the gap with a one-line cause for each. If `ocmini` fails a task opencode
passes, that is a defect against this spec — amend the spec, then fix the code.

---

## 8. Suggested phasing

Not binding, but each phase ends with a gate worth having.

| Phase | Deliverable | Gate |
|---|---|---|
| 1 | API spike: one call with one tool | Every row of §3 confirmed or corrected in this document — model id, endpoint, reasoning-continuity mechanism, and whether web search exists; backoff written |
| 2 | Model calls on `/responses`, in-memory conversation state | Reasoning continuity proven across a multi-turn tool conversation, with reasoning items returned alongside each tool result |
| 3 | Read-only tools inside a working loop | Agent can answer questions about a codebase without writing anything |
| 4 | Write, edit, shell, permissions | **T1 passes** |
| 5 | Interactive session, rendering, abort, token display | A 20-minute session with no crash; abort works mid-command |
| 6 | Compaction, task list, sub-agents, project rules | **T2 passes**; forced-threshold compaction test passes |
| 7 | Network tools, machine-readable output | **T3 passes** |
| 8 | Hardening: error text, retries, truncation, docs | **T4 passes**; §7.5 satisfied |

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Wire format differs from §3 | Phase 1 exists for exactly this; nothing else starts first |
| Reasoning continuity handled wrong → quietly weaker agent | Explicit phase-2 gate comparing with and against |
| Vague edit-failure messages → the agent flails and burns turns | Treat tool error text as a product surface; T2 detects it |
| Acceptance tasks drift toward what the code already does | Write the verification blind, before the tools exist |
| The free tier ends, throttles, or the model id moves | §3.1 confines the provider to a base URL, a key, and a model id, so the paid Muse Spark 1.3 listing or another zen model is a config change; re-check §7 budgets if tokens stop being free |
| **Rate limits stall the acceptance runs** — the likeliest cause of a failed run on this tier | Backoff with jitter from phase 1; treat 429 `FreeUsageLimitError` as expected rather than exceptional, with multi-hour retry windows assumed; a quota pause must not be scored as a §7.6 stall; budget the three consecutive T1 runs across days if needed |
| Training-rights condition applied to work that cannot be shared | §3.1: fixtures and open-source only, stated in the README; proprietary work goes to a paid tier |
| Chat-completions path returns HTTP 500 and is misread as an outage | §3: Responses-only is a known property of this tier, asserted in the phase-1 spike |
| Web search turns out not to exist on this model | §4.6 decides between the built-in tool and a local search-API tool during phase 1, before §2.1 depends on it |
| Context exhaustion on long runs | §4.9 output caps; compact well before the window fills; count reasoning tokens against the window |
