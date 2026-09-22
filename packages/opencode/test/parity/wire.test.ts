// Parity against upstream opencode for the one model ocmini targets.
//
// fixtures/muse-spark-request.json is taken from the request the UNMODIFIED
// baseline (ocmini-spec.md §0, commit b6914b39db) sent to opencode zen for
// `opencode/muse-spark-1.3-contributor-free`, captured through a recording
// proxy against the live endpoint. fixtures/muse-spark-response.txt is zen's
// real streamed reply to it.
//
// The test replays that exchange offline: a local server stands in for zen and
// returns the recorded response, while recording what ocmini sent. If ocmini
// still builds the same request, the agent still asks the model for the same
// thing — same endpoint, same client identity, same body shape, same system
// prompt, same tool schemas.
//
// This is ocmini-spec.md §7.6's wire-shape check, run per commit rather than by
// hand. It costs no tokens and touches no network: OPENCODE_DISABLE_MODELS_FETCH
// is set and the model is declared inline, so nothing is fetched from zen's
// catalogue.
//
// WHAT IS AND IS NOT ASSERTED. Only what ocmini's own code decides: the
// endpoint, the User-Agent shape, the client header, the set of body keys, the
// streaming/store/include/tool_choice flags, the system prompt, and every tool
// schema. Values that come from the remote catalogue rather than from this
// repository — max_output_tokens, the model's limits — are deliberately not
// pinned, because a change in zen's catalogue is not a regression in ocmini.
//
// WHEN THIS FAILS: a cut changed what goes on the wire. That is either a bug or
// a deliberate consequence — §2.2 cutting a tool removes it from the schema.
// §7.6 requires deliberate differences to be named in the commit that caused
// them, so update the fixture IN THAT COMMIT and say why in the message. Never
// regenerate it just to get green.
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import fixture from "./fixtures/muse-spark-request.json"

const MODEL_ID = "muse-spark-1.3-contributor-free"
const PROMPT = "Reply with exactly the word: pong"
const ROOT = path.join(import.meta.dir, "../..")

// Two parts of the system prompt describe the machine rather than ocmini: the
// <skill> entries discovered on the host, and the <env> block naming the working
// directory, workspace root and whether it is a git repo. Both are dropped from
// each side before comparing — a different host is not a change in ocmini.
const hostSpecific = (text: string) =>
  text.replace(/<skill>[\s\S]*?<\/skill>\s*/g, "").replace(/<env>[\s\S]*?<\/env>/g, "<env/>")

// Mirrors the isolation in test/lib/cli-process.ts: a throwaway HOME, no
// project config, no catalogue fetch. The provider is declared inline because
// disabling the fetch means zen's catalogue is unavailable — which is the
// point, as it keeps the test hermetic.
function isolatedEnv(home: string, baseURL: string) {
  return {
    ...process.env,
    OPENCODE_TEST_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_API_KEY: "parity-fixture-key",
    // The repo-wide test preload points this at a catalogue snapshot that
    // predates muse spark. Point it at the real entry for this model instead,
    // captured from https://models.opencode.ai/api.json, so the run is offline
    // and the model still resolves the way it does in production.
    OPENCODE_MODELS_PATH: path.join(import.meta.dir, "fixtures/muse-spark-catalogue.json"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      formatter: false,
      lsp: false,
      provider: { opencode: { options: { apiKey: "parity-fixture-key", baseURL } } },
    }),
  }
}

describe(`wire parity with upstream opencode (${MODEL_ID})`, () => {
  test(
    "the request ocmini sends matches the one the baseline sent",
    async () => {
      const recorded: Array<{ path: string; method: string; headers: Record<string, string>; body: any }> = []
      const replay = await Bun.file(path.join(import.meta.dir, "fixtures/muse-spark-response.txt")).text()

      const server = Bun.serve({
        port: 0,
        idleTimeout: 120,
        async fetch(req) {
          const url = new URL(req.url)
          recorded.push({
            path: url.pathname,
            method: req.method,
            headers: Object.fromEntries(req.headers.entries()),
            body: await req.json().catch(() => undefined),
          })
          return new Response(replay, { headers: { "content-type": "text/event-stream" } })
        },
      })

      const home = await fs.mkdtemp(path.join(os.tmpdir(), "oc-parity-"))
      const cwd = path.join(home, "project")
      await fs.mkdir(cwd, { recursive: true })

      try {
        const proc = Bun.spawn(
          ["bun", path.join(ROOT, "src/index.ts"), "run", "--model", `opencode/${MODEL_ID}`, PROMPT],
          { cwd, env: isolatedEnv(home, server.url.origin + "/v1"), stdout: "pipe", stderr: "pipe" },
        )
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        await proc.exited

        // The run also fires a title-generation call against the same model
        // (the catalogue fixture holds only this one). The agent turn is the
        // request that carries tool schemas.
        const turn = recorded.find((r) => r.body?.model === MODEL_ID && Array.isArray(r.body?.tools))
        expect(
          turn,
          `no ${MODEL_ID} request reached the stand-in server` +
            ` (models seen: ${recorded.map((r) => r.body?.model).join(", ") || "none"})` +
            `\nstdout: ${stdout}\nstderr: ${stderr}`,
        ).toBeDefined()

        // §3: this tier is Responses-only.
        expect(turn!.path).toBe(fixture.path)
        expect(turn!.method).toBe(fixture.method)

        // How ocmini identifies itself. The version varies with the build, so
        // only the shape around it is pinned.
        expect(turn!.headers["user-agent"].replace(/opencode\/[^ ]+/, "opencode/<version>")).toBe(
          fixture.userAgentShape,
        )
        expect(turn!.headers["x-opencode-client"]).toBe(fixture.clientHeader)

        // The body's shape, and the flags that decide how the turn is run.
        expect(Object.keys(turn!.body).sort()).toEqual(fixture.bodyKeys)
        expect(turn!.body.stream).toBe(fixture.stream)
        expect(turn!.body.store).toBe(fixture.store)
        expect(turn!.body.include).toEqual(fixture.include)
        expect(turn!.body.tool_choice).toBe(fixture.toolChoice)

        // The system prompt, minus the host-specific parts (see hostSpecific).
        const developer = turn!.body.input.find((item: any) => item.role === "developer")
        expect(developer, "no developer/system message in the request").toBeDefined()
        const text = typeof developer.content === "string" ? developer.content : JSON.stringify(developer.content)
        expect(hostSpecific(text)).toBe(hostSpecific(fixture.systemPrompt))

        // Every tool the model is offered, with its full schema.
        expect(turn!.body.tools).toEqual(fixture.tools)
      } finally {
        server.stop(true)
        await fs.rm(home, { recursive: true, force: true }).catch(() => {})
      }
    },
    180_000,
  )
})
