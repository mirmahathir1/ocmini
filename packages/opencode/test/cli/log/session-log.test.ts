// The --log-dir flag and the per-session log file, end to end through the real
// CLI (plan.md, step 1). The blocks written between header and footer are
// covered by the tests next to each hook.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import path from "path"
import { cliIt, testModelID } from "../../lib/cli-process"

function logs(dir: string) {
  return fs.readdirSync(dir).filter((name) => /^\d{8}T\d{6}Z-\d+\.log$/.test(name))
}

function latest(dir: string) {
  return fs.readFileSync(path.join(dir, "latest.log"), "utf8")
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
        expect(log).toMatch(/── TOOL #1 ── main · turn 1 · bash call_1\n  args\n    \{\n      "command": "printf tool-output",/)
        expect(log).toMatch(/── PERMISSION ── main · turn 1 · bash · call_1 · (?:ask|allow)\n  printf tool-output → /)
        expect(log).toMatch(/── TOOL #1 END ── main · turn 1 · bash call_1 · ok · [\d.]+m?s\n(?:.*\n)*?  output\n    tool-output\n/)
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
        expect(log).toMatch(/── PERMISSION ── main · turn 1 · bash · call_1 · ask\n  printf refused → ask \(rule: bash \*\)/)
        expect(log).toMatch(/── PERMISSION REPLY ── main · turn 1 · bash · reject\n/)
        expect(log).toMatch(/── TOOL #1 END ── main · turn 1 · bash call_1 · error · /)
        expect(log).toMatch(/\n  tools       bash 1   \(errors 1\)\n/)
        expect(log).toMatch(/denials 1 /)
      }),
    60_000,
  )
})
