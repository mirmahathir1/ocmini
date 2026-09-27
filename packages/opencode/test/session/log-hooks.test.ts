// The permission and question services write to the session log (plan.md
// step 4). Non-interactive `run` denies the question tool outright, so these
// hooks are driven in-process, with the log pointed at a temp file the same way
// test/session/log.test.ts does it.
import { afterAll, beforeAll, expect } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { MessageID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Permission.node, Question.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [[InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)

const saved = { ...process.env }
let dir: string
let file: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-log-hooks-"))
  file = path.join(dir, "hooks.log")
  process.env.OCMINI_SESSION_LOG = file
  process.env.OCMINI_SESSION_LOG_PID = String(process.pid)
  process.env.OCMINI_SESSION_LOG_START = String(Date.now())
})

afterAll(() => {
  for (const key of ["OCMINI_SESSION_LOG", "OCMINI_SESSION_LOG_PID", "OCMINI_SESSION_LOG_START"]) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function blocks(title: string) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n\n")
    .map((item) => item.trim())
    .filter((item) => item.split("\n")[0]!.includes(title))
}

const pending = <A>(list: Effect.Effect<ReadonlyArray<A>>, count: number) =>
  Effect.gen(function* () {
    while (true) {
      const items = yield* list
      if (items.length === count) return items
      yield* Effect.sleep("10 millis")
    }
  }).pipe(Effect.timeout("2 seconds"))

it.instance(
  "permission decisions by rule, asks, and the user's replies are logged",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const sessionID = SessionID.make("ses_perm_log")

      yield* permission.ask({
        sessionID,
        permission: "read",
        patterns: ["/work/a.ts"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "read", pattern: "*", action: "allow" }],
      })
      const denied = yield* permission
        .ask({
          sessionID,
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "rm *", action: "deny" }],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)

      const asked = yield* permission
        .ask({
          sessionID,
          permission: "edit",
          patterns: ["/work/b.ts"],
          metadata: { diff: "--- a/b.ts\n+++ b/b.ts\n-old\n+new" },
          always: ["*"],
          tool: { messageID: MessageID.make("msg_log"), callID: "call_7" },
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      const [request] = yield* pending(permission.list(), 1)
      yield* permission.reply({ requestID: request!.id, reply: "reject", message: "edit c.ts instead" })
      yield* Fiber.await(asked)

      const decisions = blocks("── PERMISSION ──")
      expect(decisions).toHaveLength(3)
      expect(decisions[0]).toMatch(/── PERMISSION ── main · read · allow\n  \/work\/a\.ts → allow \(rule: read \*\)$/)
      expect(decisions[1]).toMatch(/── PERMISSION ── main · bash · deny\n  rm -rf \/ → deny \(rule: bash rm \*\)$/)
      expect(decisions[2]).toMatch(
        /── PERMISSION ── main · edit · call_7 · ask\n  \/work\/b\.ts → ask \(no rule matched; default\)\n/,
      )
      // The user is shown the diff; the log shows it too, in full.
      expect(decisions[2]).toContain(
        "  metadata\n    diff:\n      --- a/b.ts\n      +++ b/b.ts\n      -old\n      +new",
      )

      const [replied] = blocks("── PERMISSION REPLY ──")
      expect(replied).toMatch(
        /── PERMISSION REPLY ── main · edit · reject\n  request     per\w+\n  waited      \d+ms\n  feedback\n    edit c\.ts instead$/,
      )
    }),
  { git: true },
)

it.instance(
  "questions and their answers are logged verbatim",
  () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const sessionID = SessionID.make("ses_question_log")
      const info = {
        question: "Which database should the tests use?",
        header: "Database",
        options: [
          { label: "SQLite (Recommended)", description: "No server needed" },
          { label: "Postgres", description: "Matches production" },
        ],
      }

      const first = yield* question.ask({ sessionID, questions: [info] }).pipe(Effect.forkScoped)
      const [one] = yield* pending(question.list(), 1)
      yield* question.reply({ requestID: one!.id, answers: [["SQLite (Recommended)"]] })
      expect(yield* Fiber.join(first)).toEqual([["SQLite (Recommended)"]])

      const second = yield* question.ask({ sessionID, questions: [info] }).pipe(Effect.forkScoped)
      const [two] = yield* pending(question.list(), 1)
      yield* question.reject(two!.id)
      yield* Fiber.await(second)

      const asked = blocks("── QUESTION #")
      expect(asked.filter((item) => / ── QUESTION #\d+ ── /.test(item))).toHaveLength(2)
      expect(asked[0]).toContain(
        [
          "  1. [Database] Which database should the tests use?",
          "       - SQLite (Recommended) — No server needed",
          "       - Postgres — Matches production",
          "       (single choice, custom answer allowed)",
        ].join("\n"),
      )
      // The second session in this log is main#2.
      expect(asked[0]).toMatch(/── QUESTION #1 ── main#2 · question 1 this session/)
      expect(blocks("── QUESTION #1 ANSWER ──")[0]).toMatch(
        /waited \d+ms\n  request     que\w+\n  1\. "SQLite \(Recommended\)"$/,
      )
      expect(blocks("── QUESTION #2 DISMISSED ──")).toHaveLength(1)
    }),
  { git: true },
)
