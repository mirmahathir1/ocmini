# ocmini — Project Specification

**ocmini is opencode with things taken out.** Not a reimplementation, not a port — a fork
of this repository, stripped down until only what is needed to run one model well
remains. That model is **Muse Spark 1.3 Contributor Free**, served by opencode zen. The
Contributor Free variant — not the paid Muse Spark 1.3 listing — is the target, and that
choice carries conditions on both cost and confidentiality (§3.1).

The language is whatever opencode is already written in: TypeScript on Bun. Choosing a
different language would convert this from a subtraction into a rewrite, which is the one
thing this project is defined not to be.

---

## 0. Method: subtract, don't rewrite

This repository is the starting point, not a reference to consult. Work begins with a
working agent — `bun install && bun dev` already runs it — and every commit after that
should make the tree smaller while the acceptance tasks in §7 keep passing.

**Baseline:** `anomalyco/opencode`, branch `dev`, commit
`b6914b39db86e196ebcc95e92a0188cdf58ef67a` (2026-09-09). MIT licensed. Fork from here and
record the commit; it is what "unchanged behaviour" means for the rest of this document.

Four rules, and they are the whole method:

1. **Cut by deletion, not by refactor.** If removing something means rewriting its
   callers, it is not a cut — it is a rewrite wearing a cut's clothing, and it belongs in a
   later phase or nowhere. Delete whole directories, whole packages, whole call sites.
   When a deletion leaves a dangling import, the fix is deleting the importer or stubbing
   the call in one line, never restructuring the module.
2. **The existing test suite is the guard rail.** `packages/opencode` ships 252 test files
   and `bun test` runs them. After every deletion, run them. The suites that fail are
   either testing something deliberately cut — delete those too, and record it — or
   telling you the cut was wrong. Nothing else gives this kind of coverage for free, and
   rewriting the project in another language throws all of it away.
3. **Keep the architecture.** Effect, layers, services, the schema split — these are not
   the target. They are pervasive across `session/` and `tool/`, and unwinding them means
   rewriting the agent loop, which is the one part of opencode most worth keeping intact.
   Strip *surfaces*: packages, commands, providers, integrations, config options. Leave
   the spine.
4. **Measure every phase.** Lines of TypeScript, package count, and the §7 acceptance
   numbers. A stripping project with no number attached drifts into refactoring; the
   numbers in §7.5 are what make "stripped down" a claim that can fail.

### 0.1 Starting measurements

Taken at the baseline commit. These are the numbers phase gates move.

| Scope | Now |
|---|---|
| Workspace packages | 33 |
| TypeScript across all packages | ~780,000 lines |
| `packages/opencode` | 678 files, ~180,000 lines |
| `packages/opencode/src` largest areas | `cli/` 27.1k · `session/` 9.4k · `server/` 7.7k · `plugin/` 6.1k · `tool/` 5.5k · `provider/` 4.4k · `acp/` 3.5k · `lsp/` 3.3k |
| Test files in `packages/opencode` | 252 |

The shape of the problem is visible in that table: `session/` and `tool/` — the agent
itself — are about 15k lines. Everything else is surface. The project is mostly a question
of how much surface can come off before the 15k starts breaking.

### 0.2 The cut record

There is no ledger file. Each deletion is one commit, and the commit message carries the
record: what was removed, how many lines, which tests went with it, and one sentence on
why it is safe. `git log` is then the project's actual output — the account that makes
the result reviewable by someone who was not present for it — and a cut that turns §7 red
three phases later is found by reading back through it and undone with `git revert`.

One cut per commit is what makes this work. A commit that deletes three unrelated
directories cannot be reverted for one of them, and its message cannot say why each was
safe.

---

## 1. Goal

Produce `ocmini`: a terminal coding agent, forked from opencode, that can be used in place
of opencode for real work, with the model choice removed as a variable. Anything that
could be done by opening opencode, selecting
`opencode/muse-spark-1.3-contributor-free`, and typing a request must still be achievable
with `ocmini`.

"Minimal" here means **narrow, not weak**. The project earns its simplicity by deleting
configurability — one provider, one model, one wire format, one prompt, one client — not
by deleting capability. The test of whether a cut was correct is §7: if removing something
makes an acceptance task fail, the cut was wrong and gets reverted.

---

## 2. Scope

### 2.1 Kept

These survive, and §7 is what proves it. "Kept" means the upstream implementation stays
where it is, minus its configuration surface.

| Capability | Lives in | Cut down to |
|---|---|---|
| Agent loop, turn structure | `src/session/prompt.ts` | One model's path through it |
| Model calls | `src/session/llm/` | The Responses path only (§3) |
| System prompt | `src/session/system.ts`, `src/session/prompt/*.txt` | One prompt file; delete the other thirteen |
| Read, write, edit | `src/tool/{read,write,edit}.ts` | Unchanged |
| Glob, grep | `src/tool/{glob,grep}.ts` | Unchanged |
| Shell | `src/tool/shell.ts` | Unchanged |
| Web fetch, web search | `src/tool/{webfetch,websearch}.ts` | Unchanged, subject to §4.6 |
| Task list | `src/tool/todo.ts`, `src/session/{todo,reminders}.ts` | Unchanged |
| Sub-agent | `src/tool/task.ts`, `src/agent/` | One level of delegation |
| Truncation discipline | `src/tool/truncate.ts` | Constants fixed, config removed |
| Compaction | `src/session/{overflow,compaction}.ts` | Unchanged |
| Permissions | `src/permission/` | Defaults hardcoded (§6) |
| Project rules (`AGENTS.md`) | `src/session/instruction.ts` | Unchanged |
| Token accounting | token bookkeeping in `src/session/prompt.ts` | Denominated in tokens, not dollars (§3) |
| Asking the user | `src/tool/question.ts`, `src/question/` | Unchanged — blocking (§7.7) |
| Interactive session | `src/cli/cmd/tui/` | Readline-grade input; see §2.2 on the TUI |
| One-shot run | `src/cli/cmd/run.ts` | Unchanged — the acceptance harness depends on it |

### 2.2 Cut

Ordered by payoff, since that is how they should be attempted. Line counts are the
baseline measurement.

| Cut | Where | ~Lines |
|---|---|---|
| Every non-agent package: web, console, desktop, stats, storybook, docs, slack, app, ui, session-ui, enterprise | `packages/*` | ~300k |
| SDKs and generated clients | `packages/{sdk,sdk-next,client,httpapi-codegen,protocol}` | ~40k |
| Full-screen TUI: panes, mouse, themes, vim keybindings | `packages/tui`, `src/cli/cmd/tui/` | ~32k + part of 27k |
| Server mode, share links, HTTP API | `src/server/`, `src/share/`, `packages/server` | ~9k |
| Plugin system and custom tools | `src/plugin/`, `packages/plugin` | ~7.7k |
| Multi-provider support, model picker, catalogue | `src/provider/` minus one path | ~4.4k |
| ACP integration | `src/acp/` | ~3.5k |
| LSP and language diagnostics | `src/lsp/`, `src/tool/lsp.ts` | ~3.4k |
| MCP client | `src/mcp/`, `packages/codemode` | ~1.8k + 11k |
| Control plane, accounts, auth beyond one key | `src/control-plane/`, `src/account/`, `src/auth/` | ~2.2k |
| Session persistence, listing, resume | `src/storage/`, `src/session/session.ts` state | ~1.4k |
| Checkpoints and revert | `src/snapshot/`, `src/session/revert.ts` | ~1k |
| Slash commands | `src/command/` | ~344 |
| Worktree and git integration beyond what shell gives | `src/worktree/`, `src/git/` | ~970 |
| IDE integration | `src/ide/` | ~54 |
| Image input | attachment paths in `session/` | — |
| Parallel tool calls | tool dispatch in `src/session/{prompt,tools}.ts` | — |

Everything in this table is a target, not a promise. A cut that turns out to require
rewriting is abandoned and recorded as attempted-and-declined, with the reason, in the
message of the next commit that lands — or in a `git commit --allow-empty` of its own if
nothing else ships. That record is worth as much as the successful ones.

**Two exceptions to that**, and to rule 1. Session persistence and parallel tool calls are
out of scope as decisions, not as opportunities. Neither may be quietly kept because
deleting it turned out to be awkward, and if deletion alone will not reach them, a bounded
refactor is authorised:

- **Session persistence.** Each run starts with an empty conversation and keeps it in
  memory only — no session store, no listing, no resume. Storage is only ~330 lines but
  threads through `session/`, so this is the one cut likely to require touching callers
  rather than deleting files. The refactor is authorised and bounded to `src/storage/` and
  `src/session/`; it is phase 6's entire job, and T3 passing afterwards is the gate. A
  build that still writes a session file nobody reads has not made this cut.
- **Parallel tool calls.** One tool call per turn, executed sequentially; a response
  requesting several is handled one at a time. Upstream issues them and the model supports
  them, so unlike every other row in this table, cutting this costs effort rather than
  saving it, and it will cost turns on search-heavy work. **That is accepted.** It is also
  the one cut expected to move the §7 acceptance numbers on its own, which is why §7.0's
  baseline gets re-measured immediately after it rather than treating the rise as a
  regression.

---

## 3. Fixed platform

The whole project rests on these facts about Muse Spark 1.3 **Contributor Free** and the
opencode zen API. Zen lists two Muse Spark 1.3 variants; ocmini targets the Contributor
Free one, and every figure below is that variant's.

**These figures came from published documentation and third-party write-ups in September
2026, and they already disagree with each other in places** — mostly because the free tier
launched on 2 September 2026 and is still moving. Do not build on them as written.

**How to verify:** the advantage of forking rather than porting is that the working client
is already here. Point it at the model and watch what it does.

```bash
bun dev .                      # opencode, from source, in this repo
```

Confirm each row by reading `src/provider/provider.ts` and `src/session/llm/native-request.ts`
to see how the request is built, then capturing one real exchange with a logging shim
around the fetch in that path. A captured request/response pair settles the endpoint, the
model id spelling, the reasoning-item shape, and the error format in one shot. Commit it
(keys redacted) to `notes/wire-capture/`; it is the reference for §7.6's regression diffs
once the provider layer starts getting cut.

| Property | Value | Confirm by |
|---|---|---|
| Variant | **Contributor Free** — the free tier, not the paid listing | Model list response |
| Model id | `muse-spark-1.3-contributor-free`, addressed as `opencode/muse-spark-1.3-contributor-free` | Captured request body |
| Provider | opencode zen, sole runtime provider (the model itself is Meta's) | `src/provider/provider.ts` |
| Base URL | `https://opencode.ai/zen/v1` | Captured request URL |
| Auth | opencode zen API key from the environment | `src/auth/` |
| Endpoints | `/responses` — **required**; `/chat/completions` is not available for this model | Captured request URL |
| Context window | 1,048,576 tokens | Model metadata |
| Max output | 131,072 tokens | Same, and `ProviderTransform.maxOutputTokens` |
| Input modalities | Text, image, and more — ocmini sends text only (§2.2) | Model metadata |
| Reasoning effort | minimal · low · medium · high · xhigh | Captured request body |
| Tool calling | Function calling, parallel calls — ocmini uses one at a time (§2.2) | Captured request body |
| Structured output | JSON-schema-guaranteed | `src/tool/json-schema.ts` |
| Prompt caching | Supported, at zero cost on this tier | Captured response usage block |
| Web search | **Unconfirmed** — see §4.6 | `webSearchEnabled()` in `src/tool/registry.ts` |
| Pricing | Free: $0 input · $0 cached · $0 output, in exchange for training rights (§3.1) | Provider metadata |

Four consequences, each easy to get wrong and hard to notice afterwards:

- **This tier is Responses-API only.** Calls to the chat-completions path are reported to
  return HTTP 500 — a wrong-endpoint error dressed as an outage. Confirm which path
  upstream takes before deleting the other one; deleting the wrong branch of
  `src/session/llm/` is the most expensive mistake available in phase 2.
- **Reasoning continuity is already implemented.** State carries across turns either by
  `previous_response_id` or, with `store: false`, by returning the reasoning items'
  `encrypted_content`. Upstream does one of these and it works. **Find out which before
  touching that code**, because breaking it is silent: everything still appears to work
  and the agent just gets measurably worse at multi-step edits. If a cut ever makes the
  §7.2/§7.4 turn counts drift upward for no visible reason, look here first.
- **Rate limits, not cost, are the binding constraint.** There is no published free quota.
  Reports describe `FreeUsageLimitError` over HTTP 429 arriving after unpredictable
  durations — one estimate puts the daily allowance near thirty cents of equivalent value
  — with multi-hour retry windows rather than instant resets. `src/session/retry.ts`
  already handles backoff; **do not cut it**, and treat 429 as expected rather than
  exceptional throughout.
- **Reasoning tokens consume the context budget** even though they are never displayed,
  and they count against output limits and quota. `src/session/overflow.ts` already
  accounts for tokens; confirm reasoning tokens are in the count before trusting the
  display.

### 3.1 The free tier is dated; the wire format is not

Three rows above are dated facts rather than stable ones, and all are cheap to fix if they
move.

- **Free is promotional and conditional.** The Contributor tier buys free tokens with
  permission to use prompts and completions to train future Meta models. That is a
  material constraint on what ocmini may be pointed at: acceptance fixtures and
  open-source work are fine, and anything proprietary or client-owned is not. Say so in
  the README rather than burying it here. The tier joined on 2 September 2026 with no
  stated end date, and is reported to rotate or throttle without notice.
- **The exact model id must be confirmed against the live API.** Sources disagree on
  whether the version is dotted (`muse-spark-1.3-contributor-free`) or hyphenated
  (`muse-spark-1-3-contributor-free`). The capture settles it. Whichever spelling is
  correct, it must carry the `-contributor-free` suffix: the bare `muse-spark-1.3` id is
  the paid listing, and silently landing on it turns a free run into a billed one. Assert
  the configured id ends in `-contributor-free` at startup, and log the resolved id on
  every acceptance run.
- **The free pool can vanish.** This is the constraint that shapes how `src/provider/`
  gets cut. Strip it to one base URL, one key, and one model id **read from
  configuration** — not to a hardcoded constant. Falling back to the paid listing or
  another zen model must stay a config change, not a code change. Cutting the provider
  layer down to a literal string is over-cutting, and §9 lists it as a risk for a reason.

---

## 4. Tool behaviour

The tools already exist and already work. This section says which survive and what changes
— it is not a build specification, and nothing here should be reimplemented.

The `.txt` files beside each tool in `src/tool/` are the model-facing descriptions. They
are prompt-engineering artefacts refined against real model behaviour over many
iterations. **Leave them alone.** Editing them is not stripping, and rewriting them is the
most reliable way to make the fork worse than its parent for no reason. The only permitted
edits are ones a cut makes literally false — for example, if image reading is removed,
`read.txt`'s claim that it returns images must go with it.

The same holds for parameter names. `oldString` stays `oldString`; field names are part of
the prompt as far as the model is concerned.

**4.1 Read** (`src/tool/read.ts`, `read.txt`) — kept. 2000-line default, 2000-character
per-line cap, 50 KB byte cap, output as `<line>: <content>`. That prefix format is
load-bearing: `edit.txt` tells the model how to strip it. Image and PDF attachment
handling goes with §2.2's image cut, and the description follows.

**4.2 Write** (`src/tool/write.ts`, `write.txt`) — kept unchanged, read-before-write rule
included.

**4.3 Edit** (`src/tool/edit.ts`, `edit.txt`) — kept unchanged, all 737 lines. Most of that
file is a cascade of replacement strategies with progressively looser matching, and it
looks like obvious dead weight to anyone stripping quickly. It is not: it is the
difference between an agent that recovers from a near-miss and one that burns three turns
on it. **This file is explicitly out of bounds for line-count reduction** — if the §7.5
size gate is missed, it is not to be met from here.

**4.4 Search** (`src/tool/glob.ts`, `src/tool/grep.ts`) — kept. Both shell out to ripgrep,
which stays a dependency; replacing it with a hand-rolled walk is a rewrite and also
slower.

**4.5 Shell** (`src/tool/shell.ts`, `src/tool/shell/`) — kept, including the 30 000-character
output cap. If the working-directory persistence behaviour changes as a side effect of
any cut, the system prompt has to change with it, or the model will assume `cd` sticks and
build wrong commands.

**4.6 Network** (`src/tool/webfetch.ts`, `src/tool/websearch.ts`) — both kept, including the
timeout, size cap, redirect limits, and refusal of private and loopback addresses.
`webSearchEnabled()` in `src/tool/registry.ts` gates search on the provider being
`opencode`, which this project's provider is — so upstream believes zen offers
server-side search. **Confirm it is available on this model and tier during phase 1**;
provider-level and model-level availability are different questions. If it is not, either
keep the tool wired to a search API behind the same §6 network permission, or cut it and
amend §2.1. Record the decision here.

**4.7 Task list** (`src/tool/todo.ts`, `src/session/{todo,reminders}.ts`) — kept. The
re-injection of todo state into context in `reminders.ts` is part of the mechanism, not
decoration; cutting it while keeping the tool produces a checklist the model stops looking
at.

**4.8 Sub-agent** (`src/tool/task.ts`, `src/agent/`) — kept, one level of delegation. The
permission narrowing in `src/agent/subagent-permissions.ts` stays: a child that can do more
than its parent is a privilege-escalation bug, not a saved file.

**4.9 Output discipline** (`src/tool/truncate.ts`) — kept, with `MAX_LINES = 2000` and
`MAX_BYTES = 51 200` fixed rather than configurable. Truncation is always marked with how
much was elided and how to get the rest; every tool returns something on failure. Silent
truncation is a bug.

**4.10 Question** (`src/tool/question.ts`, `question.txt`, `src/question/`) — kept. The
model asks the user a multiple-choice question and **the run blocks until it is answered**
(§7.7). Upstream's option conventions are part of the tool's contract and stay as they
are: a "Type your own answer" option is added automatically, a recommended option goes
first and is labelled `(Recommended)`, and answers come back as arrays of labels.

**Cut:** `src/tool/lsp.ts` (with §2.2's LSP cut),
`src/tool/skill.ts`, `src/tool/plan.ts`, `src/tool/code-mode.ts`,
`src/tool/mcp-websearch.ts`, and `src/tool/apply_patch.ts` if edit alone carries §7 — test
that before assuming it.

---

## 5. Context management

`src/session/overflow.ts` (the trigger, ~30 lines) and `src/session/compaction.ts` (the
operation, 608 lines) are kept. What comes off is configurability, not mechanism.

- **Trigger:** the usable window is the model's input limit minus a reserved buffer of
  `min(20 000, maxOutputTokens)`; compaction fires when
  `input + output + cache.read + cache.write` reaches it. `cfg.compaction.reserved` and
  `cfg.compaction.auto` become fixed values.
- **Preserved recent window:** roughly the last 25% of the usable window stays intact,
  clamped between a floor and a ceiling (`compaction.ts:118`); only older history is
  compacted.
- **Tool-output erasure:** before full compaction, the output of older tool calls is
  erased while the calls themselves are kept. Cheaper and less lossy than summarising, and
  easy to mistake for redundant machinery while cutting. It is not.
- Compaction must preserve: files touched, decisions made, outstanding todos, currently
  failing tests, and any constraint the user stated. Losing user constraints during
  compaction is the failure mode that turns a long session into wasted quota.
- With a million tokens this rarely fires, which is the point — but one verbose test run
  can still blow it, so the path must survive the strip and must be tested by forcing the
  threshold down.
- With §2.2's checkpoint cut, compaction is the only history-shortening mechanism and
  there is nothing to fall back on. A compaction that drops something is unrecoverable.

---

## 6. Permissions

`src/permission/` is kept. Rules are `{action, permission, pattern}`, matched by wildcard
against both the permission name and the argument pattern, **last matching rule wins**,
default `ask`. That resolution order is not to be "simplified" while cutting — last-match
and first-match give opposite answers on realistic rule sets, silently.

What comes off is the configuration surface. Three levels per action class — allow, ask,
deny — with these defaults compiled in and overridable per session by flag only:

| Action class | Default |
|---|---|
| Read, list, search, task list | allow |
| Write and edit inside the working directory | ask |
| Write and edit outside the working directory | deny |
| Shell | ask, with read-only commands auto-approved |
| Network fetch | ask |

`src/permission/arity.ts` (163 lines) is what decides whether a shell command is read-only.
It is kept in full. It looks like a candidate for a quick regex replacement and is not:
the failure mode is a command that looks read-only and is not.

Prompts show the exact command or diff. Options: approve once, approve this pattern for
the session, or deny with a reason — and the reason is fed back to the model as the tool
result. A denial is never silent.

A blanket auto-approve flag is required for the acceptance harness. It must refuse to run
outside a version-controlled directory.

---

## 7. Definition of done

The project is complete when **T1–T4 all pass on a clean checkout, on a machine that has
never run the project before**, plus the standing conditions in §7.5.

The acceptance tasks serve a different purpose here than they would in a from-scratch
build. They are not proof that a feature works — upstream already works. They are the
**regression harness for deletion**: the thing that tells you a cut three phases back
removed something load-bearing. Run them at the baseline before cutting anything, record
turns and tokens, and treat that record as the number to hold.

Write the verification scripts before cutting. Each task is a directory containing a
prompt, a fixture tree, and a check that exits non-zero on failure. T1's verification in
particular should be written blind — graded against the prompt, not against whatever the
agent happened to produce.

T4's fixture is committed at `fixtures/t4-taskbook/`. It is a working application with a
green 45-test suite, not a sketch: keep it that way, and run every acceptance attempt
against a copy.

### 7.0 T0 — Baseline

**Before any deletion**, run T1–T4 on the unmodified fork and record turns, tokens, and
wall-clock for each. Three T1 runs, since §7.5 needs three consecutive passes and the
baseline flakiness rate is worth knowing before it can be blamed on a cut.

This is the only phase gate that costs quota and produces no code, and it is the one most
likely to be skipped. Skipping it means every later regression is unattributable.

**Re-measure once, after phase 6.** Cutting parallel tool calls (§2.2) makes the agent take
more turns to do the same work — that is the known price of the cut, not a defect, and the
20% bands in §7.1–§7.4 would otherwise fail on it. Re-run T1–T3, record the new numbers as
the standing baseline, and note the delta in the commit that closes phase 6. This is the
**only** licensed re-baseline; every other phase is measured against T0. If the sequential
cut costs more than about a third of the turn budget on T2 or T3, say so here and
reconsider — the cut is a decision, but a decision that eats the acceptance headroom is
worth revisiting once, with numbers.

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
   tokens as the output they are — **and no worse than the T0 baseline by more than 20%**.
   Tokens are free on this tier (§3), so the budget is denominated in tokens and turns; a
   429 pause does not count against wall-clock, but a run that cannot finish inside the
   quota is still a failure.
7. No unhandled exception in `ocmini` itself; the run exits 0.

### 7.2 T2 — Brownfield debugging

**Setup:** a fixture repo of roughly 1,800 lines across 14 files with three seeded bugs —
a `TypeError` on a rare code path, an off-by-one in a slice, and a config default read
from the wrong key. Three tests fail. Bug locations are not mentioned in the prompt.

**Prompt:** *"Three tests are failing. Find the causes and fix them. Do not change the
tests."*

**Pass:** all tests green; test files byte-identical to the originals; the diff touches
≤ 40 lines; ≤ 30 turns; ≤ 1M total tokens, and within 20% of the T0 baseline. Search and
targeted reads are used to locate the bugs rather than the whole repo being dumped into
context — verifiable from the run's event log.

### 7.3 T3 — Long-horizon multi-tool task

**Setup:** empty directory, network available.

**Prompt:** *"Build a small static-site generator: read Markdown files from `content/`,
render them to HTML with a shared template, generate an index page sorted by date from
YAML front matter, and copy `static/` through. Write tests. Then create three sample posts
and build the site."*

**Pass:** the site builds; the index links all three posts in correct date order; tests
pass; the run uses sub-agent delegation or the task list at least once, showing the
long-horizon machinery survived the strip; ≤ 60 turns; ≤ 2.5M total tokens, within 20% of
baseline. Re-run with the compaction threshold forced low — the task must still complete.

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
7. ≤ 25 turns and ≤ 1M total tokens, within 20% of baseline.

Point 4 is the part that separates a real implementation from a plausible one, and point 2
is the part that catches an agent taking the easy way out.

### 7.5 Standing conditions

- **The strip is real and measured.** One workspace package. **≤ 15,000 lines of
  TypeScript** across the whole repository, down from ~780,000 — and that figure is a
  target to be revised once phase 1 measures the irreducible core, not a number to be met
  by cutting into `src/tool/edit.ts` or `src/session/compaction.ts`. If the true floor is
  higher, amend this line and say what the floor is made of. If a cut would meet the
  number by removing something §7's tasks need, the number was wrong, not the code.
- **The commit history accounts for the difference.** Every deleted directory has a
  commit of its own (§0.2), including the ones attempted and reverted.
- **The surviving upstream tests pass.** `bun test` green, with the deleted suites removed
  rather than skipped. Meaningful coverage remains over the agent loop, tool execution,
  permission decisions, and compaction — if a cut removed the last test covering one of
  those four, that is a failure whatever the line count says.
- `--help` and the README describe every flag that exists, and nothing that does not.
  Post-strip this is a real risk: flags outlive the features they configured.
- **Three consecutive T1 runs pass.** A one-in-three success rate is not a passing agent,
  it is a lucky one. When T1 goes flaky after a cut, `git log` since the last green run is
  the list of suspects and `git revert` is the diagnostic.
- Killing the process mid-turn leaves the working tree in a state version control can
  explain: no half-written files, no orphaned temporary artefacts. The conversation is
  lost by design, and that is acceptable.
- The README states that ocmini is a stripped fork of opencode, names the baseline commit,
  and carries the upstream MIT notice.

### 7.6 Regression against the baseline

Because ocmini *is* opencode, kept behaviour should be identical by construction — which
makes any observed difference a bug rather than a judgement call. Two cheap checks, run
after each phase:

- **Tool output.** Same input, same working tree: ocmini's tool results byte-identical to
  the baseline's for read framing, grep `file:line:text`, truncation notices, and edit
  failure messages. Costs no model tokens. This is the check that catches a cut that
  quietly changed a code path rather than removing one.
- **Wire shape.** The request ocmini sends for a fixed conversation matches the baseline
  capture from §3: same endpoint, same reasoning-item handling, same tool-schema encoding.
  Deliberate differences (a cut tool no longer in the schema) are named in the commit that
  caused them;
  everything else is a bug. This is the check that catches a `src/provider/` or
  `src/session/llm/` cut that broke reasoning continuity — the failure §3 warns is
  otherwise invisible.

### 7.7 Question policy

A reasoning model will sometimes ask rather than proceed — Muse Spark 1.3 is expected to
do this on ambiguous prompts and before consequential actions. **ocmini asks and waits.**
The question is put to the user, the run blocks, and the answer comes back as the tool
result. The agent does not pick the recommended option and carry on, and it does not
substitute its own best guess. Upstream's `src/tool/question.ts` already does exactly
this, so §4.10 keeps it.

This is a product decision, and it costs something worth naming: it means an ocmini run
can block indefinitely, which an agent driven by a script cannot afford. The acceptance
harness is where that lands, and it is settled explicitly rather than by weakening the
policy:

- **Acceptance runs are attended.** §7.1's prompt already allows "answering direct
  questions from the model", and that now applies to T1–T4 alike. An operator answers;
  answers are brief, factual, and chosen from the options offered where options are
  offered.
- **Every question and answer is recorded verbatim in the run log**, and the question
  count is reported alongside turns and tokens. It is not a pass/fail criterion — an agent
  that asks one good question before a consequential edit is behaving correctly — but a
  task that suddenly starts asking three questions where the baseline asked none is
  reporting something, usually that a cut damaged the system prompt or the project-rules
  loading.
- **A question left unanswered for 15 minutes aborts the run**, and the abort is a
  **failure** of that acceptance task. This bounds the blocking rather than removing it:
  the agent is entitled to wait for a human, not to hang forever in CI.
- **Answering does not extend the budget.** Time spent waiting does not count against
  wall-clock, but the turns and tokens the question consumes count normally.

A run that asks nothing and guesses wrong is worse than one that asks and waits. The
failure this policy is guarding against is an agent that silently invents a requirement,
not one that is slow.

---

## 8. Suggested phasing

Not binding, but each phase ends with a gate worth having. Every phase ends with `bun test`
green and every cut in it committed separately (§0.2).

| Phase | Deliverable | Gate |
|---|---|---|
| 0 | Fork, pin the baseline, run T1–T4 unmodified, capture the wire exchange | §7.0 numbers recorded; §3 rows confirmed or corrected here; capture committed |
| 1 | Delete non-agent packages: web, console, desktop, stats, app, ui, session-ui, storybook, docs, slack, enterprise, SDKs | ~340k lines gone; `bun dev` still runs; T1 passes |
| 2 | Collapse the provider layer to one base URL, one key, one model id from config; delete the other prompt files | Wire-shape regression clean (§7.6); reasoning continuity intact; T1 passes |
| 3 | Delete server, share, ACP, IDE, plugin system, MCP, LSP, code-mode | ~26k lines gone; tool-output regression clean; T2 passes |
| 4 | Replace the full-screen TUI with readline-grade input; delete `packages/tui` | A 20-minute session with no crash; abort works mid-command; T1 passes |
| 5 | Delete commands, checkpoints, worktree, accounts, control plane; hardcode permission and truncation defaults | T2 and T4 pass; permission suite still green |
| 6 | Session persistence and storage deleted, conversation held in memory only; tool dispatch made sequential (§2.2) | T3 passes; forced-threshold compaction test passes; **baseline re-measured** (§7.0) |
| 7 | Sweep: dead flags, dead config, dead deps, dead tests, README | **§7.5 size gate met**; `--help` accurate; three consecutive T1 runs pass |

Phases 1 and 3 are where most of the 780k goes, and they are almost entirely `rm -rf`
followed by fixing imports. Phases 2 and 6 are the ones that can break the agent silently,
and they are where rule 1 earns its place.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| **A cut breaks reasoning continuity → quietly weaker agent** | §3: find the mechanism before touching `src/session/llm/`; §7.6 wire-shape check every phase |
| **Stripping turns into rewriting** — the most likely way this project fails to finish | §0 rule 1: cut by deletion; a cut needing a refactor is recorded as declined, not attempted |
| **Cutting into the agent to hit the size number** — `edit.ts`'s matching cascade and `compaction.ts`'s tool-output erasure are the tempting targets | §4.3 and §5 put them out of bounds; §7.5 says an unreachable number gets amended, not met |
| Over-cutting the provider to a hardcoded model id | §3.1: one base URL, one key, one model id **from config** — a tier change must stay a config change |
| Deleting a test suite that was the only coverage of the agent loop | §7.5 names the four areas that must retain coverage |
| **The sequential-tool-call cut inflates turn counts and masks a real regression underneath** | §7.0: re-baseline once after phase 6 and record the delta; a later rise is then attributable again |
| Session persistence proves hard to remove and gets quietly kept | §2.2: it is a decision, not an opportunity; a build that still writes a session file has not made the cut |
| Unattributable regression three phases after the cut that caused it | §7.0 baseline + one cut per commit (§0.2) + per-phase acceptance runs make `git revert` a diagnostic |
| **Upstream drift** — opencode keeps moving and the fork diverges | The baseline is pinned; merging upstream is a deliberate act, not a habit. After phase 3 the fork has diverged enough that merges are unlikely to be worth it — say so in the README rather than pretending otherwise |
| Acceptance tasks drift toward what the code already does | Write the verification blind, before cutting |
| The free tier ends, throttles, or the model id moves | §3.1 keeps the provider a config change; re-check §7 budgets if tokens stop being free |
| **Rate limits stall the acceptance runs** — the likeliest cause of a failed run on this tier | `src/session/retry.ts` is kept, not cut; treat 429 `FreeUsageLimitError` as expected, with multi-hour retry windows assumed; a quota pause is neither a §7.7 abort nor counted against the 15-minute answer window; the per-phase acceptance runs multiply quota draw, so budget across days |
| An acceptance run blocks on a question nobody is watching | §7.7: runs are attended, and 15 minutes unanswered aborts as a failure rather than hanging |
| Training-rights condition applied to work that cannot be shared | §3.1: fixtures and open-source only, stated in the README; proprietary work goes to a paid tier |
| Chat-completions path returns HTTP 500 and is misread as an outage | §3: Responses-only is a known property of this tier, confirmed in the phase-0 capture |
| Web search turns out not to exist on this model | §4.6 decides during phase 1, before §2.1 depends on it |
| Flags and config options outliving the features they configured | §7.5: `--help` and README audited in phase 7 |
| Licence/attribution overlooked on a fork | opencode is MIT; §7.5 makes the notice a standing condition |
