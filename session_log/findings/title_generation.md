# Title generation is not part of the agent's turns

I found that generating the session title is a separate, auxiliary model request.
It runs alongside the build agent's work and does not count as one of the agent's
turns. In this session, the title request is labeled `turn 1`, but that label records
the session's current turn when the request started. It does not make title
generation a step in the build agent's execution.

This distinction explains something initially confusing: the title request appears
in [turn_01.html](../session/turns/turn_01.html), while its response appears in
[turn_02.html](../session/turns/turn_02.html). Neither its label nor the file holding
its response determines whether it counts as a turn.

## What the title request does

The title agent receives instructions to produce a brief conversation title from
the user's prompt. Its request is identified by `purpose title`, while the build
agent's requests use `purpose build`.

In this run, the title agent returned:

> Building tsum CSV summary CLI

That result becomes the session's title. It is separate from the build agent's
work of inspecting the project, writing the CLI, running commands, and producing
its final answer.

The title implementation in
[prompt.ts](../../packages/opencode/src/session/prompt.ts),
`SessionPrompt.ensureTitle`, sends its own `llm.stream(...)` request with an empty
tool set and writes the resulting text through `sessions.setTitle(...)`. It does
not call `SessionLog.turnStart(...)` or `SessionLog.turnEnd(...)`.

## How it overlaps the first two turns

The timestamps in the two HTML files show the overlap directly. These are the
local times printed in the log:

| Time | Event | File |
|---|---|---|
| `21:06:18.592` | Build turn 1 starts. | `turn_01.html` |
| `21:06:18.636` | Request #1 starts with `purpose title`. | `turn_01.html` |
| `21:06:19.299` | Request #2 starts with `purpose build`. | `turn_01.html` |
| `21:06:21.306` | Build turn 1 ends after a directory-read tool call. | `turn_01.html` |
| `21:06:21.307` | Build turn 2 starts. | `turn_02.html` |
| `21:06:21.317` | Request #3 starts with `purpose build`. | `turn_02.html` |
| `21:06:21.415` | Response #1 is logged after the title response stream ends. | `turn_02.html` |

The build agent starts its first request and then its second turn while the title
request is still running. It does not wait for title generation to finish before
continuing its task.

The code explains this behavior: the prompt loop launches title generation on its
first iteration using `Effect.forkIn(scope)`, which allows it to run concurrently
with the rest of the loop.

## Why the title response still says `turn 1`

In [log.ts](../../packages/opencode/src/session/log.ts), `tap(...)` captures the
session label and current turn when an HTTP request begins. It retains those
values in the pending response's metadata.

For request #1, the captured values are `main` and `turn 1`. When the title stream
finishes, the logger reuses them:

```text
[21:06:21.415 +19.142s] ── RESPONSE #1 ── main · turn 1 · 200 OK · ttfb 761ms
```

The `turn 1` label is therefore an association with the request's starting context.
It is not a statement that the title request advanced the build agent's turn
counter, and it is not changed to `turn 2` just because the response finishes later.

## Why its response is stored in `turn_02.html`

The original session log is one file. The HTML files are a manual split of that
log, as described in the [session log README](../README.md).

The logger accumulates a response stream and writes its response block when the
stream finishes, errors, or is cancelled. By the time the title response block was
written, turn 2 had already started. That places the block in the portion of the
log saved as `turn_02.html`.

I should therefore treat these files as slices of the recorded timeline. A file
can contain the completion of background work started during an earlier turn.
Matching `REQUEST #1` with `RESPONSE #1` is more reliable than assuming every block
in a file belongs to that file's numbered turn.

## The totals confirm the distinction

The [session footer](../session/99_session_end.html) reports:

```text
turns       25   requests 26 (1 aux)   retries 0   429s 0
```

The 25 build turns produced 25 build requests. Title generation added one auxiliary
request, bringing the request count to 26 without increasing the turn count.
The logger explicitly includes `title` in its `AUX` set and tracks requests
separately from turns.

My finding is that title generation is outside the counted turn sequence. In this
run it starts during turn 1 and finishes during turn 2, but it is neither an extra
turn nor a build step belonging to either turn. The separate finding on
[what turns actually are](turns.md) explains what does advance that sequence.
