// Per-session log (see plan.md at the repository root).
//
// One human-readable file per ocmini process, in the folder named by the
// required --log-dir flag. It records what was sent to the model and what came
// back (raw, every SSE event), every tool call with the output the model saw,
// permission and question round-trips, retries, compaction, and a footer with
// the totals ocmini-spec.md §7 grades on.
//
// Shape of the implementation, following src/cli/cmd/run/trace.ts:
//   - `start()` runs once, on the main thread, from the CLI middleware. It
//     creates the file, writes the header, and publishes the path through the
//     environment so the TUI's worker thread (same pid) appends to the same file.
//   - Every other function is a no-op unless that environment is present, so
//     in-process tests and child processes the agent spawns never write here.
//   - Writes are synchronous, one `writeSync` per block. A crash or kill loses
//     at most the response still streaming, and blocks from the two threads
//     never interleave mid-block.
//   - Every write goes through the secret scrubber in ./log-scrub.
//   - A write failure disables the log with one warning; it never breaks a
//     session.
import fs from "fs"
import os from "os"
import path from "path"
import { AsyncLocalStorage } from "async_hooks"
import { isMainThread } from "worker_threads"
import type { LLMEvent } from "@opencode-ai/llm"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Logging } from "@opencode-ai/core/observability/logging"
import { LogScrub } from "./log-scrub"

const FILE_ENV = "OCMINI_SESSION_LOG"
const START_ENV = "OCMINI_SESSION_LOG_START"
const PID_ENV = "OCMINI_SESSION_LOG_PID"

type Tokens = { input: number; cached: number; output: number; reasoning: number }

export type Stats = {
  turns: number
  requests: number
  aux: number
  retries: number
  rateLimited: number
  tokens: Tokens
  tools: Record<string, number>
  toolErrors: number
  denials: number
  questions: number
  compactions: number
  waitUser: number
  waitRate: number
  errors: number
}

type Scope = { label: string; turn: number; turns: number; tokens: Tokens }

const emptyTokens = (): Tokens => ({ input: 0, cached: 0, output: 0, reasoning: 0 })

const emptyStats = (): Stats => ({
  turns: 0,
  requests: 0,
  aux: 0,
  retries: 0,
  rateLimited: 0,
  tokens: emptyTokens(),
  tools: {},
  toolErrors: 0,
  denials: 0,
  questions: 0,
  compactions: 0,
  waitUser: 0,
  waitRate: 0,
  errors: 0,
})

const totals = emptyStats()
const scrubber = LogScrub.create(LogScrub.fromEnv(process.env))
const scopes = new Map<string, Scope>()
const counters = { request: 0, tool: 0, question: 0, root: 0, sub: 0 }
const loaded = Date.now()

let fd: number | undefined
let fdPath: string | undefined
let broken = false
let ended = false
let handedOff = false
let fatal: string | undefined
let signal: string | undefined

// ---------------------------------------------------------------------------
// File and formatting

export function enabled() {
  sync()
  return !broken && !ended && !handedOff && !!process.env[FILE_ENV] && process.env[PID_ENV] === String(process.pid)
}

// Everything above (and the maps further down) belongs to one log file. A real
// run never changes the file; when the path does change — tests pointing at a
// fresh file — the state starts clean rather than carrying another log's
// numbering, totals or failure.
let statePath: string | undefined
function sync() {
  const target = process.env[FILE_ENV]
  if (target === statePath) return
  statePath = target
  Object.assign(totals, emptyStats())
  Object.assign(counters, { request: 0, tool: 0, question: 0, root: 0, sub: 0 })
  for (const map of [scopes, seen, lastRequest, pending, asked, questions] as Array<Map<unknown, unknown>>) map.clear()
  broken = ended = handedOff = false
  fatal = signal = undefined
  if (fd !== undefined) {
    try {
      fs.closeSync(fd)
    } catch {}
  }
  fd = fdPath = undefined
}

export function file() {
  return enabled() ? process.env[FILE_ENV] : undefined
}

function write(text: string) {
  if (!enabled()) return
  const target = process.env[FILE_ENV]!
  try {
    if (fd === undefined || fdPath !== target) {
      fd = fs.openSync(target, "a")
      fdPath = target
    }
    fs.writeSync(fd, scrubber.scrub(text))
  } catch (error) {
    broken = true
    process.stderr.write(`ocmini: session log disabled after a failed write to ${target}: ${message(error)}\n`)
  }
}

function origin() {
  return Number(process.env[START_ENV]) || loaded
}

function clock(ms: number) {
  const d = new Date(ms)
  const pad = (n: number, width = 2) => String(n).padStart(width, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function secs(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
}

function duration(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
}

function num(n: number) {
  return n.toLocaleString("en-US")
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause !== undefined ? `\ncause: ${describe(error.cause)}` : ""
    return (error.stack ?? `${error.name}: ${error.message}`) + cause
  }
  return pretty(error)
}

function pretty(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? String(item) : item), 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function indent(text: string, by = 2) {
  const pad = " ".repeat(by)
  return text.split("\n").map((line) => pad + line)
}

function field(label: string, value: string) {
  return `${label.padEnd(11)} ${value}`
}

function section(label: string, text: string) {
  return [label, ...indent(text.length ? text : "(empty)")]
}

function block(kind: string, meta: Array<string | number | false | undefined>, body: string[] = []) {
  const now = Date.now()
  const extra = meta.filter((item) => item !== undefined && item !== false && item !== "").join(" · ")
  const head = `[${clock(now)} +${((now - origin()) / 1000).toFixed(3)}s] ── ${kind} ──${extra ? " " + extra : ""}`
  // A body entry may itself hold newlines (a stack in a field, say); every
  // physical line gets the indent, so nothing escapes its block.
  const lines = body.flatMap((line) => line.split("\n"))
  write("\n" + [head, ...lines.map((line) => "  " + line)].join("\n") + "\n")
}

function scope(sessionID: string | undefined): Scope | undefined {
  if (!sessionID) return undefined
  const existing = scopes.get(sessionID)
  if (existing) return existing
  counters.root++
  const created = {
    label: counters.root === 1 ? "main" : `main#${counters.root}`,
    turn: 0,
    turns: 0,
    tokens: emptyTokens(),
  }
  scopes.set(sessionID, created)
  return created
}

function where(sessionID: string | undefined) {
  const s = scope(sessionID)
  return [s?.label, s?.turn ? `turn ${s.turn}` : undefined]
}

function tokensLine(tokens: Tokens) {
  return `in ${num(tokens.input)} · cached ${num(tokens.cached)} · out ${num(tokens.output)} (reasoning ${num(tokens.reasoning)})`
}

function runningLine() {
  const tools = Object.values(totals.tools).reduce((sum, n) => sum + n, 0)
  return `turns ${totals.turns} · ${tokensLine(totals.tokens)} · tool calls ${tools}`
}

// ---------------------------------------------------------------------------
// Startup, header, footer

export class StartError extends Error {}

export function resolveDir(input: string, pwd = process.env.PWD ?? process.cwd(), home = os.homedir()) {
  const expanded = input === "~" ? home : input.startsWith("~/") ? path.join(home, input.slice(2)) : input
  return path.resolve(pwd, expanded)
}

function stamp(ms: number) {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}

function commit() {
  try {
    const result = Bun.spawnSync(["git", "-C", import.meta.dir, "rev-parse", "--short", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const out = result.stdout.toString().trim()
    return result.exitCode === 0 && out ? out : "unknown commit"
  } catch {
    return "unknown commit"
  }
}

function quote(arg: string) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)
}

// Creates the log file and makes it this process's session log. Main thread
// only, once, before any session starts. Throws StartError with the folder and
// the reason when the folder can't be created or written.
export function start(input: { dir: string; argv?: string[] }) {
  const dir = resolveDir(input.dir)
  const now = Date.now()
  const name = `${stamp(now)}-${process.pid}.log`
  const target = path.join(dir, name)
  let opened: number
  try {
    fs.mkdirSync(dir, { recursive: true })
    opened = fs.openSync(target, "wx")
  } catch (error) {
    throw new StartError(`cannot write session logs to ${dir}: ${message(error)}`)
  }

  const link = path.join(dir, "latest.log")
  try {
    fs.rmSync(link, { force: true })
    fs.symlinkSync(name, link)
  } catch {
    // Another process may have won the race for latest.log; its file is newer.
  }

  process.env[FILE_ENV] = target
  process.env[START_ENV] = String(now)
  process.env[PID_ENV] = String(process.pid)
  sync()
  fd = opened
  fdPath = target

  const argv = input.argv ?? process.argv.slice(2)
  const auto = argv.find((arg) => ["--auto", "--yolo", "--dangerously-skip-permissions"].includes(arg))
  const offset = -new Date(now).getTimezoneOffset()
  const zone = `${offset >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`
  const config = [
    process.env.OPENCODE_CONFIG ? `OPENCODE_CONFIG=${process.env.OPENCODE_CONFIG}` : undefined,
    process.env.OPENCODE_CONFIG_CONTENT ? "OPENCODE_CONFIG_CONTENT (inline)" : undefined,
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG ? "project config disabled" : undefined,
  ].filter(Boolean)
  write(
    [
      "════════ ocmini session log ════════",
      field("started", `${new Date(now).toISOString()}   (block times below are local, UTC${zone})`),
      field(
        "ocmini",
        `${InstallationVersion} (${commit()})   pid ${process.pid}   bun ${Bun.version}   ${process.platform} ${process.arch}`,
      ),
      field("cwd", process.env.PWD ?? process.cwd()),
      field("log dir", dir),
      field("log file", name),
      field("argv", argv.map(quote).join(" ") || "(none)"),
      field("perms", auto ? `auto-approve (${auto})` : "ask, per the permission rules"),
      field("config", config.join(" · ") || "files are listed as CONFIG blocks when loaded"),
    ]
      .map((line, index) => (index ? "  " + line : line))
      .join("\n") + "\n",
  )

  if (isMainThread) watch()
  return target
}

function watch() {
  process.on("exit", (code) => end(code))
  process.on("uncaughtExceptionMonitor", (error) => {
    fatal = "uncaught exception"
    error_("uncaught exception", error)
  })
  const onRejection = (reason: unknown) => {
    error_("unhandled rejection", reason)
    // With no other listener, keep the runtime's default: die on it.
    if (process.listenerCount("unhandledRejection") === 1) {
      process.off("unhandledRejection", onRejection)
      fatal = "unhandled rejection"
      throw reason
    }
  }
  process.on("unhandledRejection", onRejection)
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const onSignal = () => {
      // Someone else handles this signal (the interactive run loop clears a
      // draft on Ctrl-C); just note it and stay out of the way.
      if (process.listenerCount(sig) > 1) {
        block("SIGNAL", [sig, "handled by ocmini"])
        return
      }
      signal = sig
      end()
      process.off(sig, onSignal)
      process.kill(process.pid, sig)
    }
    process.on(sig, onSignal)
  }
}

// Totals the worker thread hands to the main thread when the TUI shuts down,
// so the one footer covers everything. After this the worker writes nothing.
export function handoff(): Stats | undefined {
  if (!enabled()) return undefined
  flush("worker shut down")
  handedOff = true
  return structuredClone(totals)
}

export function absorb(other: Stats | undefined | void) {
  if (!other) return
  for (const key of ["turns", "requests", "aux", "retries", "rateLimited", "toolErrors", "denials"] as const)
    totals[key] += other[key]
  for (const key of ["questions", "compactions", "waitUser", "waitRate", "errors"] as const) totals[key] += other[key]
  for (const key of ["input", "cached", "output", "reasoning"] as const) totals.tokens[key] += other.tokens[key]
  for (const [tool, n] of Object.entries(other.tools)) totals.tools[tool] = (totals.tools[tool] ?? 0) + n
}

export function stats() {
  return structuredClone(totals)
}

export function end(code?: number) {
  if (!enabled()) return
  flush("process exit")
  const exit = code ?? (typeof process.exitCode === "number" ? process.exitCode : 0)
  const reason = fatal
    ? `crashed: ${fatal} (${exit})`
    : signal
      ? `aborted by ${signal}`
      : exit === 0
        ? "completed (0)"
        : `failed (${exit})`
  const wall = Date.now() - origin()
  const tools = Object.entries(totals.tools)
    .sort((a, b) => b[1] - a[1])
    .map(([tool, n]) => `${tool} ${n}`)
    .join(" · ")
  write(
    "\n" +
      [
        `════════ session end ════════ [${clock(Date.now())}]`,
        field(
          "exit",
          `${reason}   wall ${duration(wall)} (waiting: user ${duration(totals.waitUser)}, rate limit ${duration(totals.waitRate)})`,
        ),
        field(
          "turns",
          `${totals.turns}   requests ${totals.requests} (${totals.aux} aux)   retries ${totals.retries}   429s ${totals.rateLimited}`,
        ),
        field("tokens", tokensLine(totals.tokens)),
        field("tools", (tools || "none") + (totals.toolErrors ? `   (errors ${totals.toolErrors})` : "")),
        field(
          "questions",
          `${totals.questions}   denials ${totals.denials}   compactions ${totals.compactions}   errors ${totals.errors}`,
        ),
      ]
        .map((line, index) => (index ? "  " + line : line))
        .join("\n") +
      "\n",
  )
  ended = true
  if (fd !== undefined) {
    try {
      fs.closeSync(fd)
    } catch {}
    fd = undefined
    fdPath = undefined
  }
}

// ---------------------------------------------------------------------------
// Sessions, prompts, turns, context

type Rule = { permission: string; pattern: string; action: string }

function rules(list: ReadonlyArray<Rule> | undefined) {
  if (!list?.length) return ["(none)"]
  return list.map((rule) => `${rule.permission} ${rule.pattern} → ${rule.action}`)
}

export function session(info: {
  id: string
  parentID?: string
  agent?: string
  title?: string
  directory?: string
  permission?: ReadonlyArray<Rule>
}) {
  if (!enabled()) return
  let label: string
  if (info.parentID) {
    counters.sub++
    label = `sub#${counters.sub}${info.agent ? " " + info.agent : ""}`
  } else {
    counters.root++
    label = counters.root === 1 ? "main" : `main#${counters.root}`
  }
  scopes.set(info.id, { label, turn: 0, turns: 0, tokens: emptyTokens() })
  block(
    "SESSION",
    [label],
    [
      field("id", info.id),
      ...(info.parentID ? [field("parent", `${info.parentID} (${scope(info.parentID)?.label})`)] : []),
      ...(info.directory ? [field("directory", info.directory)] : []),
      ...(info.title ? [field("title", info.title)] : []),
      ...(info.agent ? [field("agent", info.agent)] : []),
      ...(info.permission?.length ? ["permission", ...indent(rules(info.permission).join("\n"))] : []),
    ],
  )
}

export function prompt(sessionID: string, parts: ReadonlyArray<unknown>) {
  if (!enabled()) return
  const body = parts.flatMap((part): string[] => {
    if (!part || typeof part !== "object") return [String(part)]
    const item = part as Record<string, unknown>
    if (item.type === "text" && typeof item.text === "string")
      return item.synthetic ? ["[synthetic]", ...indent(item.text)] : item.text.split("\n")
    return [`[${String(item.type)}] ${JSON.stringify(item)}`]
  })
  block("USER PROMPT", [scope(sessionID)?.label, `before turn ${(scope(sessionID)?.turns ?? 0) + 1}`], body)
}

export function turnStart(sessionID: string, info: { step: number; agent: string; model: string }) {
  if (!enabled()) return
  const s = scope(sessionID)!
  s.turn = info.step
  s.turns++
  totals.turns++
  block(`TURN ${info.step}`, [s.label, `agent ${info.agent}`, info.model])
}

export function turnEnd(sessionID: string, info: { step: number; outcome: string; finish?: string }) {
  if (!enabled()) return
  block(
    `TURN ${info.step} END`,
    [scope(sessionID)?.label, info.outcome, info.finish && `finish ${info.finish}`],
    [field("totals", runningLine())],
  )
}

const seen = new Map<string, string>()

// Writes `body` under `kind` only when it differs from the last one written
// for `key` — model, agent and context blocks would otherwise repeat each turn.
function once(key: string, kind: string, meta: Array<string | undefined>, body: string[]) {
  const text = body.join("\n")
  if (seen.get(key) === text) return
  seen.set(key, text)
  block(kind, meta, body)
}

export function model(
  sessionID: string,
  info: {
    agent: string
    providerID: string
    modelID: string
    baseURL?: string
    runtime: string
    fallback?: string
    maxOutput?: number
    options?: Record<string, unknown>
    small?: boolean
  },
) {
  if (!enabled()) return
  const free = info.modelID.endsWith("-contributor-free") ? "✓ contributor-free" : "(not a -contributor-free id)"
  once(
    `model|${sessionID}|${info.agent}`,
    "MODEL",
    [scope(sessionID)?.label, `agent ${info.agent}`],
    [
      field("model", `${info.providerID}/${info.modelID}   ${free}`),
      field("base url", info.baseURL ?? "(provider default)"),
      field("runtime", info.runtime + (info.fallback ? ` (native unavailable: ${info.fallback})` : "")),
      // Reasoning effort, store and include live here; store/include decide how
      // reasoning carries across turns (ocmini-spec.md §3).
      field("options", info.options && Object.keys(info.options).length ? JSON.stringify(info.options) : "(none)"),
      field("max output", info.maxOutput === undefined ? "(provider default)" : num(info.maxOutput)),
      ...(info.small ? [field("small", "yes")] : []),
    ],
  )
}

export function agent(sessionID: string, info: { name: string; tools: string[]; permission: ReadonlyArray<Rule> }) {
  if (!enabled()) return
  once(
    `agent|${sessionID}|${info.name}`,
    "AGENT",
    [scope(sessionID)?.label, info.name],
    [
      field("tools", `${info.tools.length}: ${info.tools.join(", ")}`),
      "permission",
      ...indent(rules(info.permission).join("\n")),
    ],
  )
}

export function context(sessionID: string, info: { instructions: string[]; skills: string[] }) {
  if (!enabled()) return
  once(
    `context|${sessionID}`,
    "CONTEXT",
    [scope(sessionID)?.label],
    [
      field("rules", info.instructions.length ? info.instructions.join(", ") : "(no instruction files)"),
      field("skills", info.skills.length ? `${info.skills.length}: ${info.skills.join(", ")}` : "(none)"),
    ],
  )
}

export function config(source: string) {
  if (!enabled()) return
  block("CONFIG", ["loaded"], [source])
}

// ---------------------------------------------------------------------------
// Model calls: the raw wire (tap) and the summary (call)

type Call = { sessionID: string; purpose: string }

const calls = new AsyncLocalStorage<Call>()
const lastRequest = new Map<string, number>()
const AUX = new Set(["title", "compaction", "summary"])

// Runs `fn` with the session and purpose attached, so the fetch hook — which
// sees only a URL and a body — can say who made the request.
export function withCall<T>(call: Call | undefined, fn: () => T): T {
  if (!call || !enabled()) return fn()
  return calls.run(call, fn)
}

export function currentCall(): Call | undefined {
  return calls.getStore()
}

type Pending = {
  n: number
  meta: string[]
  lines: string[]
  started: number
  sse: boolean
  events: number
  bytes: number
  text: string
  rest: string
  decoder: TextDecoder
}

const pending = new Map<number, Pending>()

function headerLines(headers: Headers) {
  const out: string[] = []
  headers.forEach((value, name) => {
    if (!LogScrub.isSecretHeader(name)) return out.push(`  ${name}: ${value}`)
    const token = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(value)?.[1] ?? value
    scrubber.add(token, "api-key")
    out.push(`  ${name}: ${LogScrub.maskHeader(value)}`)
  })
  return out
}

function bodyText(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === "string") return body
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (body instanceof URLSearchParams) return body.toString()
  return `(${Object.prototype.toString.call(body)} body not captured)`
}

// Wraps one provider HTTP call: logs the request as sent, then the response
// headers and every body chunk as the SDK reads them. The SDK gets a Response
// with the same status, headers and bytes; the logger never reads ahead of it.
export async function tap(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  send: () => Promise<Response>,
): Promise<Response> {
  if (!enabled()) return send()
  const n = ++counters.request
  totals.requests++
  const call = calls.getStore()
  const purpose = call?.purpose ?? "unknown"
  if (!call || AUX.has(purpose)) totals.aux++
  if (call) lastRequest.set(`${call.sessionID}|${purpose}`, n)
  const [label, turn] = where(call?.sessionID)

  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
  const body = bodyText(init?.body)
  block(
    `REQUEST #${n}`,
    [label, turn, `purpose ${purpose}`],
    [
      `${method} ${url}` + (body !== undefined ? `   (${num(Buffer.byteLength(body))} bytes)` : ""),
      "headers",
      ...headerLines(headers),
      ...(body !== undefined ? section("body", pretty(body)) : []),
    ],
  )

  const started = Date.now()
  let res: Response
  try {
    res = await send()
  } catch (error) {
    block(
      `RESPONSE #${n}`,
      [label, turn, "no response", `after ${secs(Date.now() - started)}`],
      [...section("error", describe(error))],
    )
    throw error
  }

  if (res.status === 429) totals.rateLimited++
  const entry: Pending = {
    n,
    meta: [label, turn, `${res.status} ${res.statusText}`.trim(), `ttfb ${secs(Date.now() - started)}`].filter(
      (item): item is string => !!item,
    ),
    lines: ["headers", ...headerLines(res.headers)],
    started,
    sse: res.headers.get("content-type")?.includes("text/event-stream") ?? false,
    events: 0,
    bytes: 0,
    text: "",
    rest: "",
    decoder: new TextDecoder(),
  }
  if (entry.sse) entry.lines.push("stream")
  pending.set(n, entry)
  if (!res.body) {
    finish(entry, "end")
    return res
  }

  const reader = res.body.getReader()
  const passthrough = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      let part: Awaited<ReturnType<typeof reader.read>>
      try {
        part = await reader.read()
      } catch (error) {
        finish(entry, "error", error)
        throw error
      }
      if (part.done) {
        finish(entry, "end")
        ctrl.close()
        return
      }
      consume(entry, part.value)
      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      finish(entry, "cancel", reason)
      await reader.cancel(reason)
    },
  })
  return new Response(passthrough, { status: res.status, statusText: res.statusText, headers: res.headers })
}

function consume(entry: Pending, chunk: Uint8Array) {
  entry.bytes += chunk.byteLength
  const text = entry.decoder.decode(chunk, { stream: true })
  if (!entry.sse) {
    entry.text += text
    return
  }
  const lines = (entry.rest + text).split("\n")
  entry.rest = lines.pop() ?? ""
  const at = `+${((Date.now() - entry.started) / 1000).toFixed(3)}`
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "")
    if (!line) continue
    if (line.startsWith("data:")) entry.events++
    entry.lines.push(`  ${at} ${line}`)
  }
}

function finish(entry: Pending, how: "end" | "error" | "cancel" | "exit", reason?: unknown) {
  if (!pending.delete(entry.n)) return
  const tail = entry.decoder.decode()
  if (entry.sse) {
    const rest = (entry.rest + tail).trim()
    if (rest) entry.lines.push(`  (unterminated) ${rest}`)
  } else {
    const text = entry.text + tail
    if (text) entry.lines.push(...section("body", pretty(text)))
  }
  const took = secs(Date.now() - entry.started)
  const size = `${num(entry.bytes)} bytes` + (entry.sse ? ` · ${entry.events} events` : "")
  entry.lines.push(
    how === "end"
      ? `end · ${took} · ${size}`
      : how === "error"
        ? `stream error after ${took} · ${size}: ${message(reason)}`
        : how === "cancel"
          ? `cancelled by the reader after ${took} · ${size}` + (reason !== undefined ? `: ${message(reason)}` : "")
          : `unfinished after ${took} · ${size} (${String(reason)})`,
  )
  block(`RESPONSE #${entry.n}`, entry.meta, entry.lines)
}

function flush(reason: string) {
  for (const entry of [...pending.values()]) finish(entry, "exit", reason)
}

function findKey(value: unknown, key: string, depth = 0): unknown[] {
  if (!value || typeof value !== "object" || depth > 4) return []
  return Object.entries(value).flatMap(([name, item]) => (name === key ? [item] : findKey(item, key, depth + 1)))
}

// Collects one model call as the processor sees it — text, reasoning, tool
// calls, finish and usage — and writes it as `RESPONSE #n SUMMARY` next to the
// raw response. `attempt()` restarts it when the retry policy re-runs the call.
export function call(sessionID: string, purpose: string) {
  const fresh = () => ({
    text: "",
    reasoning: "",
    encrypted: 0,
    toolCalls: [] as string[],
    finish: undefined as string | undefined,
    usage: undefined as Tokens | undefined,
    responseID: undefined as string | undefined,
    errors: [] as string[],
    started: Date.now(),
  })
  let state = fresh()
  return {
    attempt() {
      state = fresh()
    },
    event(value: LLMEvent) {
      if (!enabled()) return
      switch (value.type) {
        case "text-delta":
          state.text += value.text
          return
        case "reasoning-delta":
          state.reasoning += value.text
          return
        case "reasoning-start":
        case "reasoning-end":
          for (const item of findKey(value.providerMetadata, "reasoningEncryptedContent"))
            if (typeof item === "string") state.encrypted += item.length
          return
        case "tool-call":
          state.toolCalls.push(`${value.name} ${value.id} ${JSON.stringify(value.input)}`)
          return
        case "provider-error":
          state.errors.push(value.message)
          return
        case "step-finish": {
          state.finish = value.reason
          const usage = value.usage
          if (usage) {
            state.usage = {
              input: usage.inputTokens ?? 0,
              cached: usage.cacheReadInputTokens ?? 0,
              output: usage.outputTokens ?? 0,
              reasoning: usage.reasoningTokens ?? 0,
            }
          }
          const id = findKey(value.providerMetadata, "responseId").find((item) => typeof item === "string")
          if (typeof id === "string") state.responseID = id
          return
        }
      }
    },
    end(outcome: { result: string; error?: unknown }) {
      if (!enabled()) return
      const s = scope(sessionID)
      if (state.usage) {
        for (const key of ["input", "cached", "output", "reasoning"] as const) {
          totals.tokens[key] += state.usage[key]
          if (s) s.tokens[key] += state.usage[key]
        }
      }
      const n = lastRequest.get(`${sessionID}|${purpose}`)
      block(
        n ? `RESPONSE #${n} SUMMARY` : "RESPONSE SUMMARY",
        [...where(sessionID), `purpose ${purpose}`, `finish ${state.finish ?? "none"}`, outcome.result],
        [
          field("took", secs(Date.now() - state.started)),
          ...(state.responseID ? [field("response", state.responseID)] : []),
          ...section("text", state.text || "(none)"),
          ...(state.reasoning ? section("reasoning", state.reasoning) : []),
          ...(state.encrypted ? [field("encrypted", `${num(state.encrypted)} bytes of reasoning`)] : []),
          ...(state.toolCalls.length
            ? section("tool calls", state.toolCalls.join("\n"))
            : [field("tool calls", "(none)")]),
          field("usage", state.usage ? tokensLine(state.usage) : "(not reported)"),
          field("session", runningLine()),
          ...state.errors.map((item) => field("error", item)),
          ...(outcome.error !== undefined ? section("error", describe(outcome.error)) : []),
        ],
      )
    },
  }
}

export function retry(
  sessionID: string,
  info: { attempt: number; message: string; wait: number; next: number; error?: unknown },
) {
  if (!enabled()) return
  totals.retries++
  totals.waitRate += info.wait
  block(
    "RETRY",
    [...where(sessionID), `attempt ${info.attempt}`],
    [
      field("cause", info.message),
      ...(info.error !== undefined ? section("error", pretty(info.error)) : []),
      field("backoff", `${secs(info.wait)} → next attempt at ${clock(info.next)}`),
    ],
  )
}

// `error_` because `error` reads badly as a parameter name everywhere else.
function error_(title: string, error: unknown, sessionID?: string) {
  if (!enabled()) return
  totals.errors++
  block("ERROR", [...where(sessionID), title], indent(describe(error), 0))
}
export { error_ as error }

// Warnings and errors from the Effect logger, forwarded by core logging.
Logging.forward((level, line) => {
  if (!enabled()) return
  block(`LOG ${level.toUpperCase()}`, [], [line])
})

// ---------------------------------------------------------------------------
// Tools, permissions, questions, sub-agents

function metadataLines(metadata: Record<string, unknown> | undefined, limit = 1000) {
  if (!metadata) return []
  const entries = Object.entries(metadata).filter(([key]) => key !== "truncated" && key !== "outputPath")
  if (!entries.length) return []
  return [
    "metadata",
    ...entries.flatMap(([key, value]) => {
      const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))
      // Before/after file contents and diffs can be whole files; the output
      // above is what the model saw, so long metadata is shown by size only.
      if (text.length > limit) return [`  ${key}: (${num(text.length)} chars)`]
      return text.includes("\n") ? [`  ${key}:`, ...indent(text, 4)] : [`  ${key}: ${text}`]
    }),
  ]
}

function truncationLines(metadata: Record<string, unknown> | undefined) {
  if (metadata?.truncated !== true) return []
  const file = typeof metadata.outputPath === "string" ? metadata.outputPath : undefined
  let size = ""
  if (file) {
    try {
      size = ` · full output ${num(fs.statSync(file).size)} bytes`
    } catch {}
  }
  return [field("truncated", `yes${size}${file ? ` at ${file}` : ""}`)]
}

export function tool(input: { sessionID: string; callID: string; name: string; args: unknown }) {
  if (!enabled()) return { end() {}, fail() {} }
  const n = ++counters.tool
  totals.tools[input.name] = (totals.tools[input.name] ?? 0) + 1
  const started = Date.now()
  const meta = () => [...where(input.sessionID), `${input.name} ${input.callID}`]
  block(`TOOL #${n}`, meta(), section("args", pretty(input.args)))
  return {
    end(result: { output: string; title?: string; metadata?: Record<string, unknown> }) {
      block(
        `TOOL #${n} END`,
        [...meta(), `ok · ${secs(Date.now() - started)}`],
        [
          ...(result.title ? [field("title", result.title)] : []),
          ...truncationLines(result.metadata),
          ...section("output", result.output),
          ...metadataLines(result.metadata),
        ],
      )
    },
    fail(error: unknown) {
      totals.toolErrors++
      const aborted = error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message))
      block(
        `TOOL #${n} END`,
        [...meta(), `${aborted ? "aborted" : "error"} · ${secs(Date.now() - started)}`],
        [...section("error", message(error))],
      )
    },
  }
}

type Asked = { sessionID: string; at: number; label: string }
const asked = new Map<string, Asked>()

export type PermissionCheck = { pattern: string; rule: Rule; matched: boolean }

export function permission(input: {
  sessionID: string
  permission: string
  callID?: string
  checks: PermissionCheck[]
  outcome: "allow" | "deny" | "ask"
  requestID?: string
  metadata?: Record<string, unknown>
}) {
  if (!enabled()) return
  if (input.outcome === "deny") totals.denials++
  if (input.outcome === "ask" && input.requestID)
    asked.set(input.requestID, { sessionID: input.sessionID, at: Date.now(), label: input.permission })
  block(
    "PERMISSION",
    [...where(input.sessionID), input.permission, input.callID, input.outcome],
    [
      ...input.checks.map(
        (check) =>
          `${check.pattern} → ${check.rule.action} ` +
          (check.matched ? `(rule: ${check.rule.permission} ${check.rule.pattern})` : "(no rule matched; default)"),
      ),
      ...(input.outcome === "ask" ? [field("asked", `request ${input.requestID}, waiting for a reply`)] : []),
      // What the user is shown (the command, the diff) — in full, since this is
      // what they are deciding on.
      ...(input.outcome === "ask" && input.metadata ? metadataLines(input.metadata, Infinity) : []),
    ],
  )
}

export function permissionReply(input: {
  requestID: string
  sessionID: string
  reply: string
  message?: string
  cascade?: boolean
}) {
  if (!enabled()) return
  const entry = asked.get(input.requestID)
  asked.delete(input.requestID)
  const wait = entry ? Date.now() - entry.at : 0
  totals.waitUser += input.cascade ? 0 : wait
  if (input.reply === "reject") totals.denials++
  block(
    "PERMISSION REPLY",
    [...where(input.sessionID), entry?.label, input.reply, input.cascade && "follows an earlier reply"],
    [
      field("request", input.requestID),
      field("waited", secs(wait)),
      ...(input.message ? section("feedback", input.message) : []),
    ],
  )
}

type QuestionInfo = {
  question: string
  header: string
  options: ReadonlyArray<{ label: string; description: string }>
  multiple?: boolean
  custom?: boolean
}
const questions = new Map<string, { n: number; at: number; sessionID: string }>()

export function questionAsk(input: {
  id: string
  sessionID: string
  questions: ReadonlyArray<QuestionInfo>
  callID?: string
}) {
  if (!enabled()) return
  const n = ++counters.question
  totals.questions++
  questions.set(input.id, { n, at: Date.now(), sessionID: input.sessionID })
  block(
    `QUESTION #${n}`,
    [...where(input.sessionID), input.callID, `question ${totals.questions} this session`],
    [
      field("request", input.id),
      ...input.questions.flatMap((item, index) => [
        `${index + 1}. [${item.header}] ${item.question}`,
        ...item.options.map((option) => `     - ${option.label} — ${option.description}`),
        `     (${item.multiple ? "multiple choice" : "single choice"}${item.custom === false ? ", no custom answer" : ", custom answer allowed"})`,
      ]),
    ],
  )
}

export function questionReply(input: { id: string; answers: ReadonlyArray<ReadonlyArray<string>> }) {
  if (!enabled()) return
  const entry = questions.get(input.id)
  questions.delete(input.id)
  const wait = entry ? Date.now() - entry.at : 0
  totals.waitUser += wait
  block(
    entry ? `QUESTION #${entry.n} ANSWER` : "QUESTION ANSWER",
    [...where(entry?.sessionID), `waited ${secs(wait)}`],
    [
      field("request", input.id),
      ...input.answers.map(
        (answer, index) => `${index + 1}. ${answer.map((item) => JSON.stringify(item)).join(", ") || "(no selection)"}`,
      ),
    ],
  )
}

export function questionReject(input: { id: string }) {
  if (!enabled()) return
  const entry = questions.get(input.id)
  questions.delete(input.id)
  const wait = entry ? Date.now() - entry.at : 0
  totals.waitUser += wait
  block(
    entry ? `QUESTION #${entry.n} DISMISSED` : "QUESTION DISMISSED",
    [...where(entry?.sessionID), `waited ${secs(wait)}`],
    [field("request", input.id)],
  )
}

export function subagentStart(input: {
  parentSessionID: string
  callID: string
  sessionID: string
  agent: string
  description: string
  prompt: string
  permission?: ReadonlyArray<Rule>
  background?: boolean
}) {
  if (!enabled()) return
  const [parent, turn] = where(input.parentSessionID)
  block(
    "SUBAGENT START",
    [scope(input.sessionID)?.label, `from ${parent}`, turn, input.callID, input.background && "background"],
    [
      field("session", input.sessionID),
      field("agent", input.agent),
      field("task", input.description),
      ...section("prompt", input.prompt),
      "permission",
      ...indent(rules(input.permission).join("\n")),
    ],
  )
}

export function subagentEnd(input: {
  sessionID: string
  status: "completed" | "error"
  result?: string
  error?: unknown
}) {
  if (!enabled()) return
  const s = scope(input.sessionID)
  block(
    "SUBAGENT END",
    [s?.label, input.status],
    [
      field("totals", `turns ${s?.turns ?? 0} · ${tokensLine(s?.tokens ?? emptyTokens())}`),
      ...(input.result !== undefined ? section("result", input.result) : []),
      ...(input.error !== undefined ? section("error", message(input.error)) : []),
    ],
  )
}

// ---------------------------------------------------------------------------
// Context management and the rest

export function overflow(sessionID: string, info: { count?: number; usable?: number; source: string }) {
  if (!enabled()) return
  block(
    "OVERFLOW",
    [...where(sessionID), info.source],
    [
      ...(info.count !== undefined ? [field("tokens", num(info.count))] : []),
      ...(info.usable !== undefined ? [field("usable", `${num(info.usable)} (compaction threshold)`)] : []),
    ],
  )
}

export function erase(sessionID: string, info: { parts: Array<{ callID: string; tool: string; tokens: number }> }) {
  if (!enabled()) return
  const freed = info.parts.reduce((sum, item) => sum + item.tokens, 0)
  block(
    "ERASE TOOL OUTPUT",
    [...where(sessionID), `${info.parts.length} calls`, `~${num(freed)} tokens freed`],
    [...info.parts.map((item) => `${item.tool} ${item.callID} (~${num(item.tokens)} tokens)`)],
  )
}

export function compaction(
  sessionID: string,
  info:
    | { stage: "scheduled"; auto: boolean; overflow?: boolean }
    | { stage: "start"; messages: number; head: number; tail?: string; previousSummary: boolean; model: string }
    | { stage: "end"; result: string; tokens?: { input: number; output: number }; error?: unknown },
) {
  if (!enabled()) return
  if (info.stage === "scheduled") {
    block("COMPACTION SCHEDULED", [
      ...where(sessionID),
      info.auto ? "auto" : "manual",
      info.overflow && "after overflow",
    ])
    return
  }
  if (info.stage === "start") {
    totals.compactions++
    block(
      "COMPACTION START",
      [...where(sessionID), info.model],
      [
        field("messages", `${info.messages} in history, ${info.head} summarised`),
        field("kept from", info.tail ?? "(nothing kept verbatim)"),
        field("previous", info.previousSummary ? "summary of an earlier compaction folded in" : "first compaction"),
      ],
    )
    return
  }
  block(
    "COMPACTION END",
    [...where(sessionID), info.result],
    [
      ...(info.tokens ? [field("tokens", `in ${num(info.tokens.input)} · out ${num(info.tokens.output)}`)] : []),
      "summary is the text of the RESPONSE SUMMARY just above",
      ...(info.error !== undefined ? section("error", pretty(info.error)) : []),
    ],
  )
}

export function todo(sessionID: string, todos: ReadonlyArray<{ content: string; status: string; priority: string }>) {
  if (!enabled()) return
  block(
    "TODO",
    [...where(sessionID), `${todos.length} items`],
    todos.length ? todos.map((item) => `[${item.status}] (${item.priority}) ${item.content}`) : ["(cleared)"],
  )
}

export function reminder(sessionID: string, info: { kind: string; text: string }) {
  if (!enabled()) return
  block(
    "REMINDER",
    [...where(sessionID), info.kind, `${num(info.text.length)} chars`],
    [info.text.split("\n")[0] ?? "", "(full text is in the next REQUEST body)"],
  )
}

export function format(info: {
  file: string
  formatter: string
  command: string[]
  exitCode?: number
  error?: string
}) {
  if (!enabled()) return
  block(
    "FORMAT",
    [info.formatter, info.error ? "failed to start" : `exit ${info.exitCode}`],
    [
      field("file", info.file),
      field("command", info.command.map(quote).join(" ")),
      ...(info.error ? [field("error", info.error)] : []),
    ],
  )
}

export * as SessionLog from "./log"
