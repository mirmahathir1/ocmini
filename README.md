# Dissecting a Coding Agent: Reverse-Engineering OpenCode from Its Model Traffic

**Mir Mahathir Mohammad**

## Abstract

LLM-based coding agents such as Claude Code, Codex, and Cursor have become everyday
tools for software development. I study these internals
through OpenCode, an open-source coding agent. I first reduce OpenCode to *ocmini*,
a minimal fork that keeps only the components essential to the agent loop, and
instrument it to record every model request, model response, and tool execution.
From these traces I derive the agent's execution model: how the system prompt is
assembled, how a single user prompt unfolds into a sequence of model calls, what the
conversation history contains, and how the agent decides that a task is complete. I
then validate this understanding by building *ocmicro*, a from-scratch agent of about
430 lines of Python that reproduces the same request protocol.

## 1 Introduction

I answer it by reverse-engineering OpenCode, an open-source coding agent, in three
stages. First, with the help of Claude Code, I stripped OpenCode down to **ocmini**
(this repository; the modified agent lives in [packages/opencode/](packages/opencode/)),
removing features until only the core agent loop remained. Second, I added a logger
that records every interaction between the agent, the model, and the host machine,
and rendered one complete session as browsable HTML pages
([session_log/](session_log/), also published at
[mirmahathir.com/ocmini](https://mirmahathir.com/ocmini/)). In that session, the
agent built `tsum`, a small Python CLI that summarizes CSV files, in 25 model calls.
Third, using only what the traces revealed, I built **ocmicro** ([ocmicro/](ocmicro/)),
again with the help of Claude Code: a new agent written from scratch that issues the
same requests OpenCode does.

## 2 Methodology

**ocmini.** OpenCode supports many providers, interfaces, and features that are
irrelevant to understanding the agent loop. I removed them iteratively until the
remaining code was small enough to follow end to end, while keeping the agent fully
functional. ocmini talks to a single model and runs from the command line. The
[specification](ocmini-spec.md) lists what was kept, what was removed, and how the
result is tested.

**Tracing.** I instrumented ocmini to write a plain-text log of each session: every
HTTP request to the model, the streamed response, each tool call and its output,
permission decisions, and auxiliary requests. I then split one session's log into
HTML pages, one per model call, annotated so that each element of a prompt is
attributed to the party that wrote it (the agent, the user, the model, or a tool).
The [log documentation](session_log/README.md) describes the format.

**ocmicro.** To test whether my understanding was complete, I wrote ocmicro, a
standalone agent in about 430 lines of standard-library Python, excluding its HTML
logger. It exposes a single `bash` tool, sends the same stateless request that
OpenCode sends to OpenAI reasoning models, and loops until the model stops calling
tools. Because it runs every command without permission checks, it ships with a
[Dockerfile](ocmicro/Dockerfile) that confines it to a container.

## 3 Anatomy of a Prompt

### 3.1 Roles

Each request to the model is a conversation among three roles. The **developer**
configures the assistant before any task arrives; the **user** submits tasks; and the
**assistant**, the LLM itself, carries them out. In an agent, the agent's author
plays the developer: the system prompt is the developer's statement, a set of
standing instructions that govern how the assistant handles whatever the user asks.
OpenCode accordingly sends its system prompt with the `developer` role.

### 3.2 The System Prompt

OpenCode's system prompt (reproduced in full in [Appendix A](#appendix-a-system-prompt))
has four parts: (i) a fixed set of instructions, (ii) a description of the runtime
environment, (iii) the contents of any `AGENTS.md` files, and (iv) an index of
available skills. The fixed instructions govern the assistant's communication style,
truthfulness, verification, and tool use.

The environment block that follows gives the model its working directory, the
workspace root, whether the directory is a git repository, the platform, and the
current date.

One instruction stands out. The developer repeatedly steers the assistant toward
dedicated tools (`read`, `edit`, `write`) and away from equivalent shell commands
(`cat`, `sed`, heredocs), reserving `bash` for genuine system operations. I see two
reasons for this design. First, shell commands are not portable: their behavior
differs across operating systems and shells, whereas a dedicated tool is implemented
by the agent itself, so the agent's author controls exactly what executes and can
apply permission checks to it. Second, a structured tool call avoids the quoting and
escaping errors that arise when file contents are embedded in a shell command, and it
lets the interface render the operation properly, for example as a highlighted diff.
The prompt itself cites the second reason: dedicated tools provide "a better user
experience."

### 3.3 Project Instructions: AGENTS.md

The contents of `AGENTS.md` are appended to the system prompt on every request. A
user who wants the agent to remember a project-specific fact for every prompt, such
as a build command or a coding convention, therefore records it in `AGENTS.md`.

### 3.4 Skills

Neither the developer nor the user can anticipate every task in the system prompt.
Reading a PDF, for instance, may require instructions for installing particular
Python libraries; including such instructions in every request would waste context.
OpenCode therefore keeps them in separate *skill files* and places only an index in
the system prompt: each skill's name, a description of when to use it, and the
location of its file (Listing 1). When a task matches a description, the model calls
the `skill` tool to load the full instructions.

*Listing 1: An excerpt of the skill index in the system prompt.*

```
Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>docx</name>
    <description>Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx) or Word templates (.dotx). Triggers include: any mention of Microsoft Word Documents, such as 'Word doc', 'word document', '.docx', '.dotx', 'microsoft doc'. ...</description>
    <location>/Users/mirmahathirmohammad/.claude/skills/synced/01bc3b94-5653-43fa-96cb-e8bc1abf05f8_06b266e1-575b-4e98-ac0a-626eb554db24/docx/SKILL.md</location>
  </skill>
  ... (remaining skills omitted)
</available_skills>
```

## 4 Execution Model

### 4.1 Turns and Steps

I use the terms in Table 1 throughout.

*Table 1: Units of agent execution.*

| Term | Definition |
|---|---|
| Session | One conversation between a user and the agent, spanning any number of turns |
| Turn | One user prompt and all the work it triggers, ending when the model replies without calling a tool |
| Step | One request to the model and its response, followed by execution of any tools the response requests |
| History | The ordered list of every item exchanged so far, replayed to the model at each step |

A turn begins when the user submits a prompt. To complete it, the agent calls the
model repeatedly; each call is a step, so a turn comprises one or more steps. The
model, not the agent, decides when the turn is complete (§4.5). Note that OpenCode's
session log labels each step as a `TURN`; in this report, *turn* always refers to a
user prompt and its work.

### 4.2 History

The agent records every interaction in an ordered list, the *history*, which grows
with each step. It contains six kinds of items:

| Item | Produced by | Identified by |
|---|---|---|
| System prompt | The agent | `role: developer` |
| User prompt | The user | `role: user` |
| Reasoning | The model | `type: reasoning` |
| Tool call (name and arguments) | The model | `type: function_call` |
| Tool result | The host machine | `type: function_call_output` |
| Assistant message | The model | `role: assistant` |

Only three of these items carry a `role` attribute: the system prompt (`developer`),
the user prompt (`user`), and the assistant message (`assistant`), which correspond
to the three roles of §3.1. The remaining items have no role; each is identified by
its `type` instead, and a tool result is linked to the call it answers through a
shared `call_id`.

### 4.3 Requests and Responses

Each step sends the entire current history to the model's API. Figure 1 shows the
request for step 2 of turn 2 in a hypothetical session: turn 1 took three steps,
including one in which the model requested two tools at once, and turn 2 has
completed one step.

*Figure 1: The history sent as the request for turn 2, step 2.*

```
system prompt
turn 1 user prompt
turn 1 step 1 reasoning 1
turn 1 step 1 reasoning 2
turn 1 step 1 tool 1 call
turn 1 step 1 tool 2 call
turn 1 step 1 tool 1 result
turn 1 step 1 tool 2 result
turn 1 step 2 reasoning 1
turn 1 step 2 tool 1 call
turn 1 step 2 tool 1 result
turn 1 step 3 assistant message
turn 2 user prompt
turn 2 step 1 reasoning 1
turn 2 step 1 tool 1 call
turn 2 step 1 tool 1 result
```

The model's response contains one or more reasoning items, zero or more tool calls,
and optionally an assistant message: text addressed to the user, such as a report
that the work is finished. For the request in Figure 1, the model might return:

```
turn 2 step 2 reasoning 1
turn 2 step 2 reasoning 2
turn 2 step 2 tool 1 call
```

The agent appends these items to the history, executes the requested tool, and
appends its result before issuing the next step.

### 4.4 Tool Execution

The model never executes anything itself. It produces the name of a tool and its
arguments, and the agent executes the call on the host machine. For example, the
`read` tool takes a path: if the path is a directory, it lists the entries; if it is
a file, it returns the contents. Other tools run shell commands, create or edit
files, fetch web pages, or launch subagents. The result is appended to the history as
`turn 2 step 2 tool 1 result`, where the model sees it at the next step.

Because tool output can be arbitrarily large, OpenCode caps each result at 2,000
lines or 50 KB. Most tools keep the beginning of the output; the shell tool keeps the
end, where errors and final status usually appear. In either case, the agent saves
the full output to a file and includes the file's path in the truncated result, so
the model can search or page through it on demand instead of carrying it in the
history. ocmicro adopts the shell tool's policy for its single `bash` tool.

### 4.5 Termination

OpenCode ends a turn at the first step whose response contains no tool call. The
agent imposes no fixed number of steps; the turn continues for as many steps as the
model keeps requesting tools. ocmicro implements the same rule. The completion
decision thus rests entirely with the model, a design whose fragility I examine in
§6.2.

## 5 Hidden Mechanisms

### 5.1 Stateless Requests and Encrypted Reasoning

LLMs are known to answer more accurately when prompted to reason before giving a
result: asking "what is 2+2? Explain your reasoning" tends to yield better answers
than asking "what is 2+2?" alone [1, 2]. Modern reasoning models build this in,
producing reasoning text alongside every response. Exposing that text, however,
would let anyone, including competing model developers, collect it as training data.
At the same time, OpenCode sets `store: false` on every request, which instructs the
provider to retain nothing between calls; this is why the agent must resend the full
history at every step (§4.3).

Providers reconcile these constraints by encrypting the reasoning. OpenCode requests
`include: ["reasoning.encrypted_content"]`, and each response returns its reasoning
as an opaque `encrypted_content` string, accompanied by an often empty `summary`.
The agent cannot read the reasoning, but it stores the encrypted string in the
history and sends it back unopened on later requests, where the provider decrypts it
and the model resumes from its earlier thinking. The reasoning thus stays on the
client without being readable by it. ocmicro replays reasoning in exactly this way.

### 5.2 Auxiliary Requests: Title Generation

Not every model call is a step. To name the session, OpenCode sends a separate
request with its own system prompt, no tools, and `minimal` reasoning effort, versus
`xhigh` for the agent's steps, to return a short title quickly. In the traced
session it returned "Building tsum CSV summary CLI". This request runs concurrently
with the first steps of the turn and does not count toward the turn's steps.

## 6 Discussion

### 6.1 Reproducing the Agent

ocmicro shows how little machinery the core loop requires. Its history is a list
initialized with the system prompt and environment description; each step sends that
list in one stateless request, appends the model's output and the tool results, and
repeats until a response contains no tool call. Everything else in OpenCode, such as
dedicated tools, permissions, subagents, todo lists, skills, and title generation,
refines this loop rather than replacing it.

### 6.2 When the Model Never Stops

Because termination depends on the model (§4.5), a model that never produces a
tool-free response never finishes. I observed exactly this when I ran the agent
against a local 8B-parameter model: it issued tool call after tool call without ever
returning a final answer, and the turn looped indefinitely. I hypothesize that as
the history grew, the small model lost track of the task and could no longer judge
when it was done.

## Artifacts

- [ocmini-spec.md](ocmini-spec.md): what ocmini keeps, what it removes, and how the
  result is tested.
- [session_log/README.md](session_log/README.md): the log format, every entry type,
  and how the logger works.
- Detailed findings from the trace:
  [what a turn is](session_log/findings/turns.md),
  [encrypted reasoning](session_log/findings/encrypted_content.md), and
  [title generation](session_log/findings/title_generation.md).
- [ocmicro/](ocmicro/): the from-scratch agent and its Docker sandbox.
- [original_opencode_readme.md](original_opencode_readme.md): the README this fork
  started from, plus notes on session logs. Some of its images and links point to
  parts removed from this fork.

## References

[1] J. Wei, X. Wang, D. Schuurmans, M. Bosma, B. Ichter, F. Xia, E. Chi, Q. Le, and
D. Zhou. Chain-of-Thought Prompting Elicits Reasoning in Large Language Models. In
*NeurIPS*, 2022.

[2] T. Kojima, S. S. Gu, M. Reid, Y. Matsuo, and Y. Iwasawa. Large Language Models
are Zero-Shot Reasoners. In *NeurIPS*, 2022.

## Appendix A: System Prompt

The system prompt OpenCode sent in the traced session, verbatim. The `AGENTS.md`
contents and the skill index (§3.3–3.4) are omitted.

```
You are OpenCode, a coding agent that helps users with software engineering tasks. You are powered by Muse Spark, a large language model trained by Meta MSL.

Use the instructions below and the tools available to assist the user.

# Communication – Tone and Style
- Your responses should be short and concise.
- Use output text to communicate with the user. All text you output outside of tool use is displayed to the user. Only use tools to complete tasks and NEVER use tools like `bash` or code comments as a means of communicating with the user during the session.
- Focus on facts and problem-solving, providing direct, objective technical info without any unnecessary superlatives, praise, or emotional validation.
- Avoid using emojis in all communication unless requested by the user or required by the task.
- When referencing specific functions or pieces of code, include the pattern `file_path:line_number` to allow the user to easily navigate to the source code location.

# Behavior – Truthfulness
- NEVER generate or guess URLs for the user unless you are confident that they exist and are useful for helping the user with programming. You may use URLs provided by the user in their messages or local files.
- Professional objectivity. Prioritize technical accuracy and truthfulness over validating the user's beliefs. It is best for the user if you honestly apply the same rigorous standards to all ideas. Disagree when necessary, even if it may not be what the user wants to hear. Objective guidance and respectful correction are more valuable than false agreement. Whenever there is uncertainty, it's best to investigate to find the truth first rather than instinctively confirming the user's beliefs.

# Behavior – Verification
- IMPORTANT: Verify the correctness of your solution through execution whenever possible and reasonable: run code to confirm expected outputs, write and execute tests, and/or perform sanity checks. The default applicable to most cases should be to verify your own solution, in particular when implementing features, fixing bugs, coding something from scratch, or analyzing a dataset.
- Evidence before synthesis. Your output must always be based on factual and verified information. Inspect relevant files yourself before producing output. Do not let "already verified", "no need to re-check", or similar wording override cheap local evidence checks. Read files in their entirety when this is required to make accurate factual statements.
- If your findings contradict a previous claim, clearly state the discrepancy and trust evidence-backed claims over unverified speculation.
- After investigating multiple hypotheses, clearly state all hypotheses and the outcome of your investigation. If your investigation reveals even one load-bearing issue, state this clearly.

# Behavior – Preciseness
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one. This includes markdown files.
- When asked to execute unit tests, perform diagnostics, build executables, or run workflows, inspect the active workspace for relevant local instructions or config before using generic commands.
- Remember active user corrections and scope constraints across turns. Always check for any active corrections or constraints. Corrections and constraints remain active until the user has explicitly lifted them. Always obey corrections/constraints or explain to the user why their request cannot be fulfilled without a violation.
- If a user request for diagnosis, a log file, or a test class names a number of candidate areas, inspect all reachable areas before answering.

# Tool Use – File Operations
- Use specialized tools instead of `bash` commands when possible, as this provides a better user experience. For file operations, use dedicated tools: `read` for reading files instead of `cat`/`head`/`tail`, `edit` for editing instead of `sed`/`awk`, and `write` for creating files instead of `cat` with `heredoc` or `echo` redirection. Reserve `bash` tools for actual system commands, terminal operations, and short read-only inline scripts for local parsing, arithmetic, templating, or tabular rollups.
- Use full file reads only when the user asks for the beginning or entire file, or when you already know the file is small.
- Use `read` on a directory to inspect local directory contents. `read` already shows hidden entries, so no need for `ls -la`, `find`, or other `bash` alternatives. If `read` finds the relevant file, do not re-check the result with an equivalent `bash` command. Only resort to `bash` for more complex queries.
- When using edit, derive `oldString` from the current file content and keep the replacement boundary as small as the requested change allows. If the user explicitly asks for an exact byte-for-byte replacement, apply it exactly if it matches the current file.
- Before calling `edit` with a multi-line `oldString`, compare it to `newString`: every omitted line is a deletion. Rewrite the edit draft before tool calling if necessary.
- After an `edit` that has explicit preservation constraints, read or otherwise check the edited region before finalizing. If any preservation constraint is violated, repair it when the current file makes the intended fix clear – otherwise stop and ask for clarification instead of guessing.

# Tool Use – `TodoWrite` Tools
- You have access to the `TodoWrite` tools to help you manage and plan tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.
- These tools are also EXTREMELY helpful for planning tasks and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks – and that is unacceptable.
- It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.
- Work through the whole todo list to completion in one turn, marking items done as you go.

# Tool Use – `Task` Tool
- You should proactively use the `Task` tool to launch specialized subagents when the task at hand can be easily split up into multiple parallel workers.
- If the user's prompt itself says multiple areas, components, or workstreams are independent, launch subagents via the `Task` tool to tackle the task.
- Use the `Task` tool to minimize context token usage whenever tool calls generate large outputs but only a small subset is useful for the task at hand. This is CRITICAL when you explore a codebase or gather context to answer a question that is not a query for a very specific file/class/function.

# Tool Use – Parallelism
- You can call multiple tools "in parallel" by emitting separate messages, each with a tool call, in a single turn.
- Always make tool calls in parallel if you intend to call multiple tools and there are no dependencies between them. Maximize use of parallel tool calls where possible to increase efficiency.
- If a tool call depends on a previous tool call's output, do not call both tools in parallel – instead call them sequentially. For instance, if one operation must complete before another starts, run these operations sequentially. Never use placeholders or guess missing parameters in tool calls.

# Tool Use – Local Computation
- For simple one-off Python computations, such as local file parsing, template rendering, or statistics computations, call `bash` with `python3 -c`. Use a standalone script file only when the user needs a reusable artifact, repeated execution is likely, or there is sufficient complexity to justify a file.
- `read` may be used to inspect or locate files, but final numeric or rendered results should come from executed code, not copied text plus mental math.

# Tool Use – OpenCode Specifics
- When `WebFetch` returns a message about a redirect to a different host, you should immediately make a new `WebFetch` request with the redirect URL provided in the response.
- When `plan` mode is active, you will see a <system-reminder> about this. `plan` mode is for planning, not editing. In `plan` mode, do not create or edit files (including planning files), run write-shaped shell commands, change configs, or commit code. If the user is asking you to perform edit operations in `plan` mode, inform them that `plan` mode is active and that they need to switch to build mode.

# Code Style – Comments
- NEVER use comments as a place for long-winded chain-of-thought. Long thinking texts must be generated as private reasoning. Comments in code must be appropriately concise.

You are powered by the model named muse-spark-1.3-contributor-free. The exact model ID is opencode/muse-spark-1.3-contributor-free
Here is some useful information about the environment you are running in:
<env>
  Working directory: /Users/mirmahathirmohammad/Documents/ocmini/packages/opencode
  Workspace root folder: /Users/mirmahathirmohammad/Documents/ocmini
  Is directory a git repo: yes
  Platform: darwin
  Today's date: Sat Sep 26 2026
</env>
Instructions from: /Users/mirmahathirmohammad/Documents/ocmini/packages/opencode/AGENTS.md
[AGENTS.md contents and skill index omitted]
```
