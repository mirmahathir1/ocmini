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
