# What turns actually are in this session log

I found that a turn in this log is one model-processing cycle of the task agent.
The agent sends the current conversation to the model, processes the response,
and executes any tools requested during that cycle. If the task requires another
model response, the agent starts another turn with the updated conversation and
tool results.

These are execution turns inside the agent's work on a task. A single user prompt
can cause many of them. The 25 numbered turns in this example do not mean the user
sent 25 prompts or that the model made exactly 25 HTTP requests of every kind.

## What happens during a turn

The normal cycle is:

1. **Prepare the model input.** The agent gathers the conversation history,
   instructions, available tools, and results of earlier tool calls.
2. **Ask the model what to do next.** The model can produce visible text and tool
   requests as its response streams back.
3. **Process the response and run requested tools.** Tool calls and their results
   are recorded with the current turn. A tool can execute while the response
   stream is still being processed.
4. **Record the turn's outcome.** The agent decides whether it needs another
   model-processing cycle, should handle compaction, or can stop.

When a tool result needs to be shown to the model, it enters the conversation used
by the next turn. The tool result is the output of the current cycle; the model's
reaction to that result happens in a later cycle.

## Where the code draws the boundary

In [prompt.ts](../../packages/opencode/src/session/prompt.ts), the task loop calls
`SessionLog.turnStart(...)` before creating and running the processor for an
assistant message. It calls `SessionLog.turnEnd(...)` after
`handle.process(...)` returns.

In [log.ts](../../packages/opencode/src/session/log.ts), `turnStart(...)` increments
the session's turn counter and the overall turn total. Its accompanying comment
defines turns as the agent's model calls and explicitly excludes loop iterations
that only handle compaction or a queued subtask.

This makes the turn counter a measure of the agent's model-processing steps.
Individual streamed events, individual tools, and auxiliary requests do not each
advance it. Retrying an HTTP request inside a processing cycle also does not by
itself create another turn boundary.

Turn numbers are maintained per session. The `main` label identifies the main
session; sub-agent sessions have their own scopes and turn numbering. This finding
describes the recorded session and the logger implementation linked above.

## What the first two turns actually did

In [turn_01.html](../session/turns/turn_01.html), the build agent's model request is
`REQUEST #2`, with `purpose build`. The model asks to run the `read` tool on:

```text
/Users/mirmahathirmohammad/Documents/ocmini/packages/opencode
```

The tool returns a directory listing. The turn ends with:

```text
TURN 1 END ── main · continue · finish tool-calls
```

Here, `finish tool-calls` identifies how the model response ended, and `continue`
records the processor's outcome. The agent needs another model step with the
directory listing available in its history.

In [turn_02.html](../session/turns/turn_02.html), the next build request is
`REQUEST #3`. The model asks the `bash` tool to run:

```sh
pwd && ls -la
```

The command's output becomes another tool result. Turn 2 also ends with
`continue · finish tool-calls`, allowing the agent to continue its investigation
in the following turn.

The user has not needed to send another message between these steps. The agent is
continuing work on the original task.

## A turn, a request, and a tool call are different counts

| Item | What it counts | Example from this session |
|---|---|---|
| User prompt | Input submitted by the user. | The instruction to build the CLI starts the task. |
| Turn | A task agent's model-processing cycle. | Turn 1 asks to inspect a directory. |
| Request | An HTTP call sent to the provider, including auxiliary calls and retries. | Request #1 generates the title; request #2 serves build turn 1. |
| Tool call | An operation requested by the model and executed by a tool. | Tool #1 runs `read`; tool #2 runs `bash`. |

A turn may request no tools, one tool, or several tools. A model response that
finishes the task can contain a final answer without requesting another tool.
Several stream events can describe pieces of the same response without creating
additional turns.

Likewise, the number of HTTP requests can exceed the number of turns. In this
session, the [footer](../session/99_session_end.html) records 25 turns and 26
requests, including one auxiliary request and no retries. The extra request is
[title generation](title_generation.md), which runs independently of the counted
turn sequence.

## How I should read the numbered HTML files

The files group sections of a log that was originally written as one continuous
file. Their names help navigate the run, but the blocks inside them carry the
more precise information:

- `TURN n` and `TURN n END` identify the task agent's processing boundaries.
- `purpose build` and `purpose title` distinguish why a model request was made.
- Matching request and response numbers connects an HTTP call across file
  boundaries.
- Tool call identifiers connect a requested operation to its completion and
  output.

For example, the title response in `turn_02.html` still carries `turn 1` because its
request started during that turn. Its presence does not make title generation a
step of turn 2. Understanding the turn boundaries and the request identities
separately lets me reconstruct what the agent did without confusing overlapping
background work with the agent's next decision.
