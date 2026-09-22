// Tier-A smoke tests for read-only commands. Each test asserts only that the
// command exits 0 and produces *some* output in the isolated harness env.
//
// These are not behavioral tests — they're the cheapest possible signal that
// the dependency-layer wiring (config load, DB init, server boot, provider
// resolution) doesn't crash for the broad class of "no inputs, no side
// effects" commands. A regression in any shared layer (an Effect.fail that
// propagates out of a service constructor, a renamed env var, a broken DB
// migration) will fail one or more of these tests.
//
// If a future change should make one of these commands intentionally fail in
// an empty env, update the assertion + add a note explaining the new contract.
//
// Speed: each test pays ~1.5s for bun startup. See script/prebuild-test-cli.ts for an opt-in pre-built binary that
// cuts per-spawn cost when this suite gets bigger.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("opencode read-only commands (smoke)", () => {
  // `generate` boots the server and emits the OpenAPI document. It is the
  // only surviving no-inputs, no-side-effects command, so it now carries the
  // whole tier-A signal: config load, DB init and server boot all run before
  // a byte is printed. The providers/models/agent/stats smokes that used to
  // sit here went with their commands.
  cliIt.live(
    "generate: exits 0 and emits the OpenAPI document",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["generate"])
        opencode.expectExit(r, 0, "generate")
        expect(r.stdout).toContain('"openapi"')
      }),
    60_000,
  )
})
