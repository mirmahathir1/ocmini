// The --log-dir flag and the per-session log file, end to end through the real
// CLI (plan.md, step 1). The blocks written between header and footer are
// covered by the tests next to each hook.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import os from "os"
import path from "path"
import { cliIt, testModelID } from "../../lib/cli-process"

function logs(dir: string) {
  return fs.readdirSync(dir).filter((name) => /^\d{8}T\d{6}Z-\d+\.log$/.test(name))
}

function latest(dir: string) {
  return fs.readFileSync(path.join(dir, "latest.log"), "utf8")
}

// The one block whose header line starts with `head`.
function block(log: string, head: string) {
  const found = log
    .split("\n\n")
    .map((item) => item.trim())
    .filter((item) =>
      item
        .split("\n")[0]!
        .replace(/^\[[^\]]+\] /, "")
        .startsWith(head),
    )
  expect(found, `one block headed ${head}`).toHaveLength(1)
  return found[0]!
}

// The indented lines under `label` in a block, dedented.
function section(text: string, label: string) {
  const lines = text.split("\n")
  const start = lines.indexOf(`  ${label}`)
  expect(start, `section ${label}`).toBeGreaterThan(-1)
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("    ")) break
    body.push(line.slice(4))
  }
  return body.join("\n")
}

// A logged request's body, parsed back from its pretty-printed form.
function requestBody(log: string, head: RegExp) {
  const found = log
    .split("\n\n")
    .map((item) => item.trim())
    .find((item) => head.test(item.split("\n")[0]!))
  expect(found, `a block matching ${head}`).toBeDefined()
  return JSON.parse(section(found!, "body"))
}

describe("--log-dir", () => {
  cliIt.concurrent(
    "is required by every command that starts a session",
    ({ opencode }) =>
      Effect.gen(function* () {
        for (const argv of [["run", "hi"], [], ["serve"]]) {
          const result = yield* opencode.spawn(argv, { timeoutMs: 15_000 })
          expect(result.exitCode, `opencode ${argv.join(" ")}`).toBe(1)
          expect(result.stderr).toContain("--log-dir is required")
        }
      }),
    60_000,
  )

  cliIt.concurrent(
    "is not needed for --help or --version",
    ({ opencode }) =>
      Effect.gen(function* () {
        for (const argv of [["--help"], ["run", "--help"], ["--version"]]) {
          const result = yield* opencode.spawn(argv, { timeoutMs: 15_000 })
          opencode.expectExit(result, 0, `opencode ${argv.join(" ")}`)
        }
        const help = yield* opencode.spawn(["run", "--help"])
        expect(help.stderr).toContain("--log-dir")
      }),
    60_000,
  )

  cliIt.concurrent(
    "writes one log per run, with a header, a footer and a latest.log link",
    ({ llm, opencode, logDir }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* opencode.run("say hi")
        opencode.expectExit(result, 0)
        // ocmini never prints where the log went.
        expect(result.stdout + result.stderr).not.toContain(logDir)

        const files = logs(logDir)
        expect(files).toHaveLength(1)
        expect(files[0]).toEndWith(`.log`)
        expect(fs.readlinkSync(path.join(logDir, "latest.log"))).toBe(files[0]!)

        const text = fs.readFileSync(path.join(logDir, files[0]!), "utf8")
        expect(text.startsWith("════════ ocmini session log ════════\n")).toBe(true)
        expect(text).toContain(`  log dir     ${logDir}\n`)
        expect(text).toContain(`  log file    ${files[0]}\n`)
        expect(text).toMatch(/\n════════ session end ════════ \[[\d:.]+\]\n  exit        completed \(0\) /)
      }),
    60_000,
  )

  cliIt.concurrent(
    "resolves a relative folder against the directory it was run from",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const from = path.join(home, "somewhere")
        fs.mkdirSync(from)
        yield* llm.text("ok")
        const result = yield* opencode.spawn(["run", "--log-dir", "rel-logs", "--model", testModelID, "hi"], {
          env: { PWD: from },
        })
        opencode.expectExit(result, 0)
        expect(logs(path.join(from, "rel-logs"))).toHaveLength(1)
      }),
    60_000,
  )

  if (process.platform !== "win32")
    cliIt.concurrent(
      "fails at startup when the folder can't be written",
      ({ opencode, home }) =>
        Effect.gen(function* () {
          const locked = path.join(home, "locked")
          fs.mkdirSync(locked, { mode: 0o555 })
          const result = yield* opencode.spawn(["run", "--log-dir", path.join(locked, "logs"), "hi"])
          fs.chmodSync(locked, 0o755)
          expect(result.exitCode).toBe(1)
          expect(result.stderr).toContain(`cannot write session logs to ${path.join(locked, "logs")}`)
        }),
      60_000,
    )
})

describe("session log contents", () => {
  cliIt.concurrent(
    "records the prompt, each turn, the model's reply and the totals",
    ({ llm, opencode, logDir }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm", { usage: { input: 120, output: 7 } })
        const result = yield* opencode.run("say hi")
        opencode.expectExit(result, 0)

        const log = latest(logDir)
        expect(log).toMatch(/── SESSION ── main\n  id          ses_/)
        expect(log).toMatch(/── USER PROMPT ── main · before turn 1\n  .*say hi/)
        expect(log).toMatch(/── TURN 1 ── main · agent build · test\/test-model\n/)
        expect(log).toMatch(/── AGENT ── main · build\n  tools       \d+: .*\bread\b/)
        expect(log).toMatch(/── MODEL ── main · agent build\n  model       test\/test-model /)
        expect(log).toMatch(/── REQUEST #\d+ ── main · turn 1 · purpose build\n/)
        expect(log).toMatch(/── RESPONSE #\d+ SUMMARY ── main · turn 1 · purpose build · finish stop · continue\n/)
        expect(log).toContain("\n  text\n    hello from the test llm\n")
        expect(log).toContain("usage       in 120 · cached 0 · out 7 (reasoning 0)")
        expect(log).toMatch(/── TURN 1 END ── main · continue · finish stop\n  totals      turns 1 · /)
        expect(log).toMatch(/\n  turns       1   requests \d+ \(\d+ aux\)   retries 0   429s 0\n/)
        expect(log).toMatch(/\n  tokens      in 120 · cached 0 · out 7 \(reasoning 0\)\n/)
      }),
    60_000,
  )

  cliIt.concurrent(
    "records a rate-limited call and the retry that followed",
    ({ llm, opencode, logDir }) =>
      Effect.gen(function* () {
        yield* llm.error(429, { error: { message: "Rate limit exceeded", type: "rate_limit" } })
        yield* llm.text("recovered")
        const result = yield* opencode.run("try it", { timeoutMs: 45_000 })
        opencode.expectExit(result, 0)
        expect(result.stdout).toBe("recovered\n")

        const log = latest(logDir)
        expect(log).toMatch(/── RESPONSE #\d+ ── main · turn 1 · 429[^\n]*· ttfb /)
        expect(log).toContain("Rate limit exceeded")
        expect(log).toMatch(/── RETRY ── main · turn 1 · attempt 1\n  cause       [^\n]+\n/)
        expect(log).toMatch(/\n  backoff     [\d.]+s → next attempt at \d{2}:\d{2}:\d{2}\.\d{3}\n/)
        expect(log).toMatch(/retries 1   429s 1\n/)
        expect(log).toMatch(/exit        completed \(0\)   wall \d+s \(waiting: user 0s, rate limit \d+s\)/)
      }),
    60_000,
  )

  cliIt.concurrent(
    "records a tool call, its permission check and the output the model saw",
    ({ llm, opencode, logDir }) =>
      Effect.gen(function* () {
        yield* llm.tool("bash", { command: "printf tool-output", description: "Print deterministic output" })
        yield* llm.text("done")
        const result = yield* opencode.run("use a tool", { extraArgs: ["--dangerously-skip-permissions"] })
        opencode.expectExit(result, 0)

        const log = latest(logDir)
        expect(log).toMatch(
          /── TOOL #1 ── main · turn 1 · bash call_1\n  args\n    \{\n      "command": "printf tool-output",/,
        )
        expect(log).toMatch(/── PERMISSION ── main · turn 1 · bash · call_1 · (?:ask|allow)\n  printf tool-output → /)
        // The logged output is exactly what the model was sent back: compare it
        // with the tool message in the next request's body, as logged. (Not
        // with "tool-output": under load the bash tool sometimes returns
        // nothing, and the log must say so rather than what was expected.)
        const end = block(log, "── TOOL #1 END ── main · turn 1 · bash call_1 · ok · ")
        const next = requestBody(log, /── REQUEST #\d+ ── main · turn 2 · purpose build/)
        const sent = next.messages.find((message: any) => message.role === "tool" && message.tool_call_id === "call_1")
        expect(sent, "no tool result in the turn-2 request").toBeDefined()
        expect(section(end, "output")).toBe(sent.content === "" ? "(empty)" : sent.content)
        expect(log).toMatch(/── RESPONSE #\d+ SUMMARY ── main · turn 1 · purpose build · finish tool-calls/)
        expect(log).toContain('  tool calls\n    bash call_1 {"command":"printf tool-output"')
        expect(log).toMatch(/── TURN 2 ── main · agent build/)
        expect(log).toMatch(/\n  tools       bash 1\n/)
      }),
    60_000,
  )

  cliIt.concurrent(
    "records a permission the run refused and the tool call it failed",
    ({ llm, opencode, logDir }) =>
      Effect.gen(function* () {
        // Harmless even if it ran: the run's directory is the test runner's.
        yield* llm.tool("bash", { command: "printf refused", description: "Print" })
        yield* llm.text("ok")
        // Non-interactive run without --auto rejects anything that asks.
        yield* opencode.run("try a tool", { timeoutMs: 30_000, permission: { bash: "ask" } })

        const log = latest(logDir)
        expect(log).toMatch(
          /── PERMISSION ── main · turn 1 · bash · call_1 · ask\n  printf refused → ask \(rule: bash \*\)/,
        )
        expect(log).toMatch(/── PERMISSION REPLY ── main · turn 1 · bash · reject\n/)
        expect(log).toMatch(/── TOOL #1 END ── main · turn 1 · bash call_1 · error · /)
        expect(log).toMatch(/\n  tools       bash 1   \(errors 1\)\n/)
        expect(log).toMatch(/denials 1 /)
      }),
    60_000,
  )

  cliIt.concurrent(
    "records a sub-agent's whole run inside the task call that started it",
    ({ llm, opencode, logDir }) =>
      Effect.gen(function* () {
        yield* llm.tool("task", {
          description: "Find the config",
          prompt: "Look for the config file and report its path.",
          subagent_type: "general",
        })
        yield* llm.text("it is in ./config.json") // the sub-agent's reply
        yield* llm.text("done") // the main agent, after the task returns
        const result = yield* opencode.run("delegate", { extraArgs: ["--dangerously-skip-permissions"] })
        opencode.expectExit(result, 0)

        const log = latest(logDir)
        const order = [
          /── TOOL #1 ── main · turn 1 · task call_1\n/,
          /── SESSION ── sub#1 general\n  id          ses_\w+\n  parent      ses_\w+ \(main\)\n/,
          /── SUBAGENT START ── sub#1 general · from main · turn 1 · call_1\n(?:.*\n)*?  prompt\n    Look for the config file and report its path\.\n/,
          /── USER PROMPT ── sub#1 general · before turn 1\n/,
          /── TURN 1 ── sub#1 general · agent general · test\/test-model\n/,
          /── REQUEST #\d+ ── sub#1 general · turn 1 · purpose general\n/,
          /── RESPONSE #\d+ SUMMARY ── sub#1 general · turn 1 · purpose general · finish stop/,
          /── SUBAGENT END ── sub#1 general · completed\n  totals      turns 1 · in \d+ [^\n]*\n  result\n    it is in \.\/config\.json\n/,
          /── TOOL #1 END ── main · turn 1 · task call_1 · ok · /,
          /── TURN 2 ── main · agent build/,
        ]
        let at = 0
        for (const pattern of order) {
          const match = pattern.exec(log.slice(at))
          expect(match, `${pattern} after offset ${at}`).not.toBeNull()
          at += match!.index + match![0].length
        }
        // The sub-agent's turn counts in the session's totals.
        expect(log).toMatch(/\n  turns       3   /)
      }),
    60_000,
  )

  cliIt.concurrent(
    "records a forced compaction from the overflow that triggered it to the summary",
    ({ llm, opencode, logDir }) =>
      Effect.gen(function* () {
        // The test model has a 100k context and 10k output, so 90k usable.
        yield* llm.text("a long answer", { usage: { input: 95_000, output: 10 } })
        yield* llm.text("Summary: the user asked for a long answer and got one.")
        yield* llm.text("continuing after compaction")
        const result = yield* opencode.run("go", { env: { OPENCODE_DISABLE_AUTOCOMPACT: "0" } })
        opencode.expectExit(result, 0)

        const log = latest(logDir)
        expect(log).toMatch(
          /── OVERFLOW ── main · turn 1 · reached by this response\n  tokens      95,010\n  usable      90,000 \(compaction threshold\)\n/,
        )
        expect(log).toMatch(/── COMPACTION SCHEDULED ── main · turn 1 · auto\n/)
        expect(log).toMatch(/── COMPACTION START ── main · turn 1 · test\/test-model\n  messages    \d+ in history/)
        expect(log).toMatch(/── REQUEST #\d+ ── main · turn 1 · purpose compaction\n/)
        expect(log).toMatch(
          /── RESPONSE #\d+ SUMMARY ── main · turn 1 · purpose compaction · finish stop · continue\n(?:.*\n)*?  text\n    Summary: the user asked for a long answer and got one\.\n/,
        )
        expect(log).toMatch(/── COMPACTION END ── main · turn 1 · continue\n/)
        // The compaction pass is not a turn: the next agent call is turn 2.
        expect(log).toMatch(/── TURN 2 ── main · agent build · test\/test-model\n/)
        expect(log).not.toContain("── TURN 3 ──")
        expect(log).toMatch(/compactions 1 /)
      }),
    60_000,
  )

  cliIt.concurrent(
    "records the todo list each time it is written",
    ({ llm, opencode, logDir }) =>
      Effect.gen(function* () {
        yield* llm.tool("todowrite", {
          todos: [
            { content: "Write the parser", status: "in_progress", priority: "high" },
            { content: "Add tests", status: "pending", priority: "medium" },
          ],
        })
        yield* llm.text("planned")
        const result = yield* opencode.run("plan it", { extraArgs: ["--dangerously-skip-permissions"] })
        opencode.expectExit(result, 0)

        expect(latest(logDir)).toMatch(
          /── TODO ── main · turn 1 · 2 items\n  \[in_progress\] \(high\) Write the parser\n  \[pending\] \(medium\) Add tests\n/,
        )
      }),
    60_000,
  )

  cliIt.live(
    "still writes the footer when the run is interrupted, with the call in flight",
    ({ llm, opencode, logDir }) =>
      Effect.gen(function* () {
        yield* llm.hang
        const run = yield* opencode.startRun("wait forever")
        yield* llm.wait(2) // the title call and the agent turn
        yield* Effect.sleep("300 millis")
        run.interrupt()
        const result = yield* run.result
        expect(result.exitCode).not.toBe(0)

        const log = latest(logDir)
        expect(log).toMatch(/── REQUEST #\d+ ── main · turn 1 · purpose build\n/)
        // The streaming response was cut off; what had arrived is kept.
        expect(log).toMatch(
          /── RESPONSE #\d+ ── main · turn 1 · 200[^\n]*\n(?:.*\n)*?  unfinished after [\d.]+m?s · \d+ bytes/,
        )
        expect(log).toMatch(/\n  exit        aborted by SIGINT   wall /)
      }),
    30_000,
  )
})

// These start a log the way the CLI does and then do something the CLI can't
// be made to do on purpose: crash, or write from a second handle the way the
// TUI's worker thread does. The footer must still be written, in the right
// place, and a crash must still end the process the way the runtime would.
describe("session log from a bare script", () => {
  const crash = async (how: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-log-crash-"))
    try {
      const script = [
        `import { SessionLog } from ${JSON.stringify(path.join(import.meta.dir, "../../../src/session/log"))}`,
        `SessionLog.start({ dir: ${JSON.stringify(dir)}, argv: [] })`,
        how,
      ].join("\n")
      const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" })
      const [stderr] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text()])
      return { code: await proc.exited, stderr, log: fs.readFileSync(path.join(dir, "latest.log"), "utf8") }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test("an uncaught exception", async () => {
    const result = await crash(`setTimeout(() => { throw new Error("boom from a timer") }, 1)`)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("boom from a timer")
    expect(result.log).toMatch(/── ERROR ── uncaught exception\n  Error: boom from a timer\n/)
    expect(result.log).toMatch(/\n  exit        crashed: uncaught exception \(1\)   wall /)
  })

  test("an unhandled rejection", async () => {
    const result = await crash(`Promise.reject(new Error("nobody caught this"))`)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("nobody caught this")
    expect(result.log).toMatch(/── ERROR ── unhandled rejection\n  Error: nobody caught this\n/)
    expect(result.log).toMatch(/\n  exit        crashed: unhandled rejection \(1\)   wall /)
  })

  test("the footer lands after blocks appended through another handle", async () => {
    // The TUI's worker appends on its own fd; the main thread writes the
    // footer. A non-append fd here once wrote the footer over the worker's
    // blocks, right after the header.
    const result = await crash(
      [
        `const fs = require("fs")`,
        `const fd = fs.openSync(process.env.OCMINI_SESSION_LOG, "a")`,
        `fs.writeSync(fd, "\\n[worker] ── SESSION ── main\\n  written by another handle\\n")`,
      ].join("\n"),
    )
    expect(result.code).toBe(0)
    const worker = result.log.indexOf("[worker] ── SESSION ── main\n  written by another handle\n")
    const footer = result.log.indexOf("════════ session end ════════")
    expect(worker).toBeGreaterThan(result.log.indexOf("  config "))
    expect(footer).toBeGreaterThan(worker)
    expect(result.log).toMatch(/\n  exit        completed \(0\)   wall /)
  })
})
