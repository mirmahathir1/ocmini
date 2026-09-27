import { describe, expect, test } from "bun:test"
import path from "path"
import { LogScrub } from "../../src/session/log-scrub"

// A real `encrypted_content` blob, from zen's recorded reply in the parity
// fixture. Random base64url is exactly what a careless token pattern eats.
const replay = await Bun.file(path.join(import.meta.dir, "../parity/fixtures/muse-spark-response.txt")).text()
const encrypted = /"encrypted_content":"([^"]+)"/.exec(replay)![1]

describe("session log scrubber", () => {
  const scrub = LogScrub.create([
    { value: "zen-key-0123456789abcdef", kind: "api-key" },
    ...LogScrub.fromEnv({
      MY_SERVICE_TOKEN: "tok_live_9f8e7d6c5b4a",
      KEYCHAIN_PATH: "/Users/me/Library/Keychains/login.keychain-db",
      SHORT_KEY: "abc",
      FEATURE_TOKEN: "true",
      HOME: "/Users/me",
    }),
  ]).scrub

  const cases: Array<{ name: string; input: string; gone: string; kind: string }> = [
    {
      name: "configured API key",
      input: "Bearer zen-key-0123456789abcdef",
      gone: "zen-key-0123456789abcdef",
      kind: "api-key",
    },
    {
      name: "env value by name",
      input: "echo tok_live_9f8e7d6c5b4a",
      gone: "tok_live_9f8e7d6c5b4a",
      kind: "env:MY_SERVICE_TOKEN",
    },
    { name: "sk- key", input: "key is sk-proj-AbCdEf0123456789XyZ", gone: "sk-proj-AbCdEf0123456789XyZ", kind: "sk" },
    {
      name: "GitHub token",
      input: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      gone: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      kind: "github",
    },
    {
      name: "GitHub PAT",
      input: "github_pat_11ABCDEFG0123456789_abcdefghij",
      gone: "github_pat_11ABCDEFG0123456789_abcdefghij",
      kind: "github",
    },
    { name: "Slack token", input: "xoxb-1234567890-abcdefghij", gone: "xoxb-1234567890-abcdefghij", kind: "slack" },
    { name: "AWS access key", input: "AKIAIOSFODNN7EXAMPLE", gone: "AKIAIOSFODNN7EXAMPLE", kind: "aws" },
    {
      name: "JWT",
      input: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      gone: "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      kind: "jwt",
    },
    {
      name: "private key block",
      input: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
      gone: "b3BlbnNzaC1rZXktdjEAAAAA",
      kind: "private-key",
    },
    {
      name: "private key block inside a JSON string",
      input: '"-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAKCAQEA\\n-----END RSA PRIVATE KEY-----"',
      gone: "MIIEpAIBAAKCAQEA",
      kind: "private-key",
    },
    {
      name: ".env line",
      input: "DATABASE_PASSWORD=hunter2hunter2\nPORT=3000",
      gone: "hunter2hunter2",
      kind: "assignment",
    },
    {
      name: ".env line inside a JSON string",
      input: '"PORT=1\\nSTRIPE_SECRET_KEY=whsec_abcdef123456"',
      gone: "whsec_abcdef123456",
      kind: "assignment",
    },
    { name: "JSON pair", input: '{"apiKey": "plain-config-value-123"}', gone: "plain-config-value-123", kind: "json" },
    {
      name: "query parameter",
      input: "GET https://x.test/v1?api_key=qwertyuiop123&x=1",
      gone: "qwertyuiop123",
      kind: "query",
    },
  ]

  for (const item of cases) {
    test(`masks ${item.name}`, () => {
      const out = scrub(item.input)
      expect(out).not.toContain(item.gone)
      expect(out).toContain(`[redacted:${item.kind}`)
      // The last four characters stay, so two secrets can still be told apart
      // — except for key blocks, which all end in dashes.
      if (item.kind !== "private-key") expect(out).toContain("…" + item.gone.slice(-4))
    })
  }

  test("leaves encrypted reasoning alone", () => {
    const body = JSON.stringify({ type: "reasoning", encrypted_content: encrypted })
    expect(scrub(body)).toBe(body)
  })

  test("leaves names that only look secret alone", () => {
    const text = [
      '{"max_output_tokens": 32000, "prompt_cache_key": "ses_0123456789abcdef"}',
      "input_tokens=9706 total_tokens=9771",
      "HOME=/Users/me",
      "/Users/me/Library/Keychains/login.keychain-db",
      "FEATURE_TOKEN is true",
    ].join("\n")
    expect(scrub(text)).toBe(text)
  })

  test("masks a secret added after creation everywhere it appears", () => {
    const scrubber = LogScrub.create()
    scrubber.add("late-arriving-token-42", "api-key")
    expect(scrubber.scrub("a late-arriving-token-42 b")).toBe("a [redacted:api-key …n-42] b")
  })

  test("keeps the auth scheme of a masked header", () => {
    expect(LogScrub.isSecretHeader("Authorization")).toBe(true)
    expect(LogScrub.isSecretHeader("x-api-key")).toBe(true)
    expect(LogScrub.isSecretHeader("content-type")).toBe(false)
    expect(LogScrub.maskHeader("Bearer sk-abcdefghijklmnop")).toBe("Bearer [redacted:api-key …mnop]")
  })
})
