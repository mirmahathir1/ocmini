// In-process tests for the session log's formatting. The log is switched on
// by pointing its environment at a temp file, the same way `start()` does for
// the TUI's worker thread; `start()` itself (which also installs process
// handlers) is exercised through the CLI in test/cli/log/session-log.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SessionLog } from "../../src/session/log"

const HEAD = /^\[\d{2}:\d{2}:\d{2}\.\d{3} \+\d+\.\d{3}s\] ── /

let dir: string
let file: string
const saved = { ...process.env }

async function contents() {
  return fs.readFile(file, "utf8")
}

// The text of the one block whose header contains `title`.
async function block(title: string) {
  const blocks = (await contents()).split("\n\n").map((item) => item.trim())
  const found = blocks.filter((item) => item.split("\n")[0]!.includes(title))
  expect(found.length, `blocks titled ${title}`).toBe(1)
  return found[0]!
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-session-log-"))
  file = path.join(dir, "test.log")
  process.env.OCMINI_SESSION_LOG = file
  process.env.OCMINI_SESSION_LOG_PID = String(process.pid)
  process.env.OCMINI_SESSION_LOG_START = String(Date.now())
})

afterAll(async () => {
  for (const key of ["OCMINI_SESSION_LOG", "OCMINI_SESSION_LOG_PID", "OCMINI_SESSION_LOG_START"]) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await fs.rm(dir, { recursive: true, force: true })
})

describe("session log", () => {
  test("resolves --log-dir against PWD and expands ~", () => {
    expect(SessionLog.resolveDir("logs", "/work/project", "/home/me")).toBe("/work/project/logs")
    expect(SessionLog.resolveDir("../logs", "/work/project", "/home/me")).toBe("/work/logs")
    expect(SessionLog.resolveDir("~/ocmini-logs", "/work/project", "/home/me")).toBe("/home/me/ocmini-logs")
    expect(SessionLog.resolveDir("/var/logs", "/work/project", "/home/me")).toBe("/var/logs")
  })

  test("writes nothing when the log belongs to another process", async () => {
    process.env.OCMINI_SESSION_LOG_PID = String(process.pid + 1)
    SessionLog.config("should not appear")
    process.env.OCMINI_SESSION_LOG_PID = String(process.pid)
    expect(await Bun.file(file).exists()).toBe(false)
  })

  test("formats blocks with a greppable header and an indented body", async () => {
    SessionLog.session({ id: "ses_main", directory: "/work", title: "t" })
    SessionLog.prompt("ses_main", [{ type: "text", text: "line one\nline two" }])
    const handle = SessionLog.tool({ sessionID: "ses_main", callID: "call_1", name: "read", args: { filePath: "/a" } })
    handle.end({ output: "1: hello", title: "a", metadata: { truncated: false, loaded: [] } })

    const session = await block("── SESSION ──")
    expect(session).toMatch(new RegExp(HEAD.source + "SESSION ── main$", "m"))
    expect(session).toContain("\n  id          ses_main")

    const prompt = await block("── USER PROMPT ──")
    expect(prompt.split("\n").slice(1)).toEqual(["  line one", "  line two"])

    const start = await block("── TOOL #1 ──")
    expect(start.split("\n")[0]).toMatch(new RegExp(HEAD.source + "TOOL #1 ── main · read call_1$"))
    expect(start).toContain('  args\n    {\n      "filePath": "/a"\n    }')

    const end = await block("── TOOL #1 END ──")
    expect(end.split("\n")[0]).toMatch(/TOOL #1 END ── main · read call_1 · ok · \d+ms$/)
    expect(end).toContain("  output\n    1: hello")
  })

  test("logs a request and every streamed event, with the auth header masked", async () => {
    const sse = [
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"po',
      'ng"}\n\ndata: [DONE]\n\n',
    ]
    const res = await SessionLog.withCall({ sessionID: "ses_main", purpose: "build" }, () =>
      SessionLog.tap(
        "https://zen.test/v1/responses",
        {
          method: "POST",
          headers: { authorization: "Bearer zen-secret-key-123456", "content-type": "application/json" },
          body: JSON.stringify({ model: "m", input: [{ role: "user", content: "hi zen-secret-key-123456" }] }),
        },
        async () =>
          new Response(
            new ReadableStream({
              start(ctrl) {
                for (const chunk of sse) ctrl.enqueue(new TextEncoder().encode(chunk))
                ctrl.close()
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req_1" } },
          ),
      ),
    )
    // The SDK's copy is byte-identical to what the server sent.
    expect(await res.text()).toBe(sse.join(""))

    const request = await block("── REQUEST #1 ──")
    expect(request.split("\n")[0]).toMatch(/REQUEST #1 ── main · purpose build$/)
    expect(request).toContain("POST https://zen.test/v1/responses")
    expect(request).toContain("authorization: Bearer [redacted:api-key …3456]")
    expect(request).toContain('"model": "m"')
    // Once seen in a header, the key is masked in bodies too.
    expect(await contents()).not.toContain("zen-secret-key-123456")

    const response = await block("── RESPONSE #1 ──")
    expect(response.split("\n")[0]).toMatch(/RESPONSE #1 ── main · 200 · ttfb \d+ms$/)
    expect(response).toContain("x-request-id: req_1")
    const events = response.split("\n").filter((line) => /^ {4}\+\d+\.\d{3} /.test(line))
    expect(events.map((line) => line.replace(/^ {4}\+\d+\.\d{3} /, ""))).toEqual([
      "event: response.created",
      'data: {"type":"response.created"}',
      'data: {"type":"response.output_text.delta","delta":"pong"}',
      "data: [DONE]",
    ])
    expect(response).toMatch(/end · \d+ms · \d+ bytes · 3 events$/)
  })

  test("summarises a model call next to its raw response", async () => {
    const call = SessionLog.call("ses_main", "build")
    call.event({ type: "text-delta", id: "t", text: "po" } as never)
    call.event({ type: "text-delta", id: "t", text: "ng" } as never)
    call.event({ type: "tool-call", id: "call_9", name: "grep", input: { pattern: "x" } } as never)
    call.event({
      type: "step-finish",
      index: 0,
      reason: "tool-calls",
      usage: { inputTokens: 9706, outputTokens: 65, reasoningTokens: 54, cacheReadInputTokens: 113 },
    } as never)
    call.end({ result: "continue" })

    const summary = await block("── RESPONSE #1 SUMMARY ──")
    expect(summary.split("\n")[0]).toMatch(/RESPONSE #1 SUMMARY ── main · purpose build · finish tool-calls · continue$/)
    expect(summary).toContain("  text\n    pong")
    expect(summary).toContain('  tool calls\n    grep call_9 {"pattern":"x"}')
    expect(summary).toContain("usage       in 9,706 · cached 113 · out 65 (reasoning 54)")
    expect(SessionLog.stats().tokens).toEqual({ input: 9706, cached: 113, output: 65, reasoning: 54 })
  })

  // Last: a broken log stays off for the rest of the process.
  test("a failed write disables the log with one warning instead of throwing", async () => {
    const original = process.stderr.write.bind(process.stderr)
    const warnings: string[] = []
    process.stderr.write = ((chunk: string) => {
      warnings.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      process.env.OCMINI_SESSION_LOG = dir // a directory: opening it for append fails
      SessionLog.config("first")
      SessionLog.config("second")
    } finally {
      process.stderr.write = original
      process.env.OCMINI_SESSION_LOG = file
    }
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("session log disabled")
    expect(SessionLog.enabled()).toBe(false)
  })
})
