# ocmini

**ocmini exists to answer one question: what does a coding agent actually do?**

It's a stripped-down fork of [OpenCode](https://github.com/anomalyco/opencode) that
runs one model and records everything that happens: every prompt, every reply, every
tool call and its result. You can read an agent's work step by step instead of
guessing at it.

**[Open the debug trace](https://mirmahathir.com/ocmini/)** to see one real run. The
agent was asked to build `tsum`, a small Python CLI that summarizes CSV files. It
finished in 25 turns and just under 8 minutes, with all 30 of its tests passing.

## How an agent works

An agent is a loop around a model. The model can't touch your files or run anything.
It can only reply with text or ask for a tool to be run. Ordinary code does the rest:

```text
your task --> build the prompt --> model --> did it ask for a tool?
                     ^                           |              |
                     |                          yes             no
                     |                           v              v
                     +--- add the result <-- run the tool    final answer
```

One trip around this loop is a **turn**. The loop itself is in
[prompt.ts](packages/opencode/src/session/prompt.ts).

The `tsum` run shows what that means in practice:

- **The model remembers nothing.** Nothing is stored between requests, so each one
  resends the whole conversation. The first build request was 57,637 bytes and the
  last was 209,680.
- **Caching makes that affordable.** Each prompt starts with the previous one, so
  645,385 of the run's 681,843 input tokens came from the cache.
- **The model asks and the agent acts.** Each tool call passes a permission check and
  runs, then its output becomes text in the next prompt.
- **Not every model call is a turn.** A separate request generates the session title,
  which is why the run has 26 requests for 25 turns.
- **Your task is a tiny part of the prompt.** This is the last prompt of the run, by
  size:

| Part of the prompt | Share |
|---|---|
| The model's encrypted reasoning | 51% |
| System prompt | 16% |
| The model's tool calls | 15% |
| Tool definitions | 12% |
| Tool results | 6% |
| Your task | 0.3% |

## How to read the debug trace

The [debug trace](https://mirmahathir.com/ocmini/) is that one run, split into pages:

| Page | What it shows |
|---|---|
| **Session setup** | The version, the working directory and how the session started |
| **User prompt** | The task, word for word |
| **Session title** | A side request that names the session. It runs alongside the agent, so it isn't part of any turn |
| **Turn 01 to 25** | Everything that happened in that turn. **Previous turn** and **Next turn** step through them |
| **Final summary** | Exit status, time, tokens and tool counts |

### Reading a turn

Each turn page opens with a diagram of what happened, in time order. Each row is one
step, each column is an actor, and each arrow shows who acted on whom. The actors are
ocmini, the model and the tool, plus `you` on Turn 19, the one time ocmini stops to ask
for permission. Times are when ocmini saw each step. Click a row to open the log entry
it came from.

Below the diagram is the log itself, a list of timestamped entries. Click one to open
it. In `[21:06:21.317 +19.044s]`, the second time counts from the start of the process.

| Entry | What it tells you |
|---|---|
| `TURN n` | The turn begins, with the agent and model it uses |
| `REQUEST #n` | The exact prompt sent to the model |
| `RESPONSE #n SUMMARY` | The model's reply in short form: its text, tool calls, finish reason and token use. Read this first |
| `RESPONSE #n` | The same reply as the raw stream, event by event |
| `TOOL #n` | A tool call and its arguments |
| `PERMISSION` | Whether the call was allowed, and by which rule |
| `TOOL #n END` | The tool's output, exactly as the model receives it |
| `TODO` | The agent's task list after an update |
| `TURN n END` | The turn ends, with its finish reason and running totals |

Turn 1 also has `AGENT`, `CONTEXT` and `MODEL` entries. They show the tools on offer,
the instructions and skills loaded, and the model settings.

Watch for two things:

- **Check `finish`, not `continue`.** Every `TURN n END` says `continue`, including
  the last one. `finish tool-calls` means the model asked for a tool, so another turn
  follows. `finish stop` means it's done.
- **Entries are in the order they were written, not the order things happened.** A
  `RESPONSE` entry is written only when its stream ends, and tools can start before
  that. So in Turn 02, `TOOL #2` sits above `RESPONSE #3`, the reply that asked for
  it. The diagram avoids this by splitting each reply into its moments, which is why
  one `RESPONSE` can appear on several rows.

### Reading a prompt

The prompt is the `input` list inside a `REQUEST` entry's `body`.

1. **Click Show prompts** in the toolbar. This opens each request down to its `input`
   list.
2. **Read the labels.** Each item says who wrote it:

   | Label | Written by |
   |---|---|
   | `ocmini · system prompt`, `ocmini · title prompt`, `ocmini · title instruction` | ocmini |
   | `you · task prompt` | The user |
   | `model · bash call`, `model · reasoning (encrypted)` | The model |
   | `tool · bash result` | The tool that ran |

   Trust these labels over the JSON `role`. On the **Session title** page,
   `Generate a title for this conversation:` has the role `user`, but ocmini wrote it.

3. **Look for red.** Red text isn't hardcoded: it was filled in at runtime. That covers
   the task, the model's output, tool results, the working directory, the date, and any
   `AGENTS.md` files and skills that were loaded. Everything else is fixed wording from
   ocmini's source.
4. **Click a string to read it.** Long strings run off the screen in the tree, so this
   is the way to read the system prompt. The popup shows real line breaks and keeps the
   red.
5. **Click New this turn only** to hide what the previous prompt already contained.
   What's left is what the last turn added. **Show full prompts** brings the rest back.

Below `input`, the `tools` list holds the 12 tool definitions the model can call.
Labels and red appear only inside `REQUEST` entries. Reasoning items are red but
unreadable, because the provider encrypts them and the agent passes them back
unopened.

### Try it: follow one step

1. Open [Turn 02](https://mirmahathir.com/ocmini/session/turns/turn_02.html) and click
   **New this turn only**. `REQUEST #3` has four new items: two reasoning items, a
   `read` call and its result. That's everything turn 1 added.
2. Open `RESPONSE #3 SUMMARY`. The model asks `bash` to run `pwd && ls -la`, and
   `finish tool-calls` says the loop goes on.
3. Open `PERMISSION` and `TOOL #2 END`. The call is allowed, and the output is what the
   model will see.
4. Open [Turn 03](https://mirmahathir.com/ocmini/session/turns/turn_03.html) and click
   **New this turn only** again. That `bash` call and its output are now in the prompt.

## Run it yourself

ocmini talks to one model, Muse Spark 1.3 Contributor Free on OpenCode Zen (see
[§3 of the spec](ocmini-spec.md#3-fixed-platform)).

```bash
bun install
bun dev --log-dir ~/ocmini-logs .                     # interactive
bun dev run --log-dir ~/ocmini-logs "fix the tests"   # one-shot
```

`--log-dir` is required. Each run writes one plain-text log, and `latest.log` in that
folder points to the newest. You get the log file, not a website: the debug trace is
one log split into pages by hand.

## Where to go next

- [ocmini-spec.md](ocmini-spec.md): what ocmini keeps, what it removes and how the
  result is tested
- [original_opencode_readme.md](original_opencode_readme.md): the README this fork
  started from, plus notes on session logs. Some of its images and links point to parts
  removed from this fork
- [session_log/README.md](session_log/README.md): the full log format, every entry
  type and how the logger works
- Findings from reading the trace:
  [what a turn is](session_log/findings/turns.md),
  [encrypted reasoning](session_log/findings/encrypted_content.md) and
  [title generation](session_log/findings/title_generation.md)
- The code: [prompt.ts](packages/opencode/src/session/prompt.ts) runs the loop,
  [processor.ts](packages/opencode/src/session/processor.ts) handles each model reply,
  [system.ts](packages/opencode/src/session/system.ts) builds the system prompt and
  [tool/](packages/opencode/src/tool/) holds the tools
