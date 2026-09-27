// Secret scrubber for the session log (plan.md, "Redaction"). Every line the
// log writes passes through one of these just before it hits the file, so each
// block kind gets the same treatment. It only ever touches the logged copy —
// the bytes on the wire are never changed.
//
// Deliberately NOT here: generic high-entropy detection. It would mask the
// model's `encrypted_content` and every hash in a tool output. Token shapes are
// anchored so a match cannot start in the middle of a base64url blob.

export type Secret = { value: string; kind: string }

// Values shorter than this are too likely to be ordinary words ("true",
// "1234") to mask everywhere they appear.
const MIN_SECRET = 8

const BOUNDARY = "(?<![A-Za-z0-9_-])"

const TOKEN_SHAPES: Array<{ kind: string; pattern: RegExp }> = [
  {
    kind: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { kind: "sk", pattern: new RegExp(BOUNDARY + "sk-[A-Za-z0-9_-]{16,}", "g") },
  { kind: "stripe", pattern: new RegExp(BOUNDARY + "(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}", "g") },
  { kind: "github", pattern: new RegExp(BOUNDARY + "gh[pousr]_[A-Za-z0-9]{30,}", "g") },
  { kind: "github", pattern: new RegExp(BOUNDARY + "github_pat_[A-Za-z0-9_]{20,}", "g") },
  { kind: "slack", pattern: new RegExp(BOUNDARY + "xox[abposr]-[A-Za-z0-9-]{10,}", "g") },
  { kind: "aws", pattern: new RegExp(BOUNDARY + "AKIA[0-9A-Z]{16}(?![0-9A-Z])", "g") },
  {
    kind: "jwt",
    pattern: new RegExp(BOUNDARY + "eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}", "g"),
  },
]

// A name that holds a secret: API_KEY, GITHUB_TOKEN, db_password, clientSecret…
// It has to END in the secret word, so `max_output_tokens` and
// `prompt_cache_key` are left alone.
const SECRET_NAME =
  "[A-Za-z0-9_-]*?(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|auth[_-]?token|token|password|passwd)"

// NAME=value at the start of a line, including a line inside a JSON string
// where the newline is the two characters `\n`.
const ASSIGNMENT = new RegExp(
  `(^|\\\\n|[\\s;"'])((?:export\\s+)?${SECRET_NAME})=([^\\s"'\\\\&]{${MIN_SECRET},})`,
  "gim",
)

// "name": "value" pairs, as in a config file echoed back or a request body.
const JSON_PAIR = new RegExp(`("${SECRET_NAME}"\\s*:\\s*")([^"\\\\]{${MIN_SECRET},})(")`, "gi")

// ?api_key=… and friends inside any URL.
const QUERY = /([?&](?:api[_-]?key|key|token|access_token|secret|password|sig|signature)=)([^&\s"'#]+)/gi

// Header names whose value is a credential.
const SECRET_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie)$|key|token|secret|password/i

export function mask(value: string, kind: string) {
  const tail = value.length >= MIN_SECRET ? " …" + value.slice(-4) : ""
  return `[redacted:${kind}${tail}]`
}

export function isSecretHeader(name: string) {
  return SECRET_HEADER.test(name)
}

// `Bearer abc…` keeps its scheme so the log still says how the call was authed.
export function maskHeader(value: string) {
  const match = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(value)
  if (match) return `${match[1]} ${mask(match[2], "api-key")}`
  return mask(value, "header")
}

// Values of environment variables whose NAME says they are secret, collected
// once. Paths, booleans and numbers are skipped: KEYCHAIN_PATH's value is a
// path, and masking every occurrence of it would only hide where things are.
export function fromEnv(env: Record<string, string | undefined>): Secret[] {
  return Object.entries(env).flatMap(([name, value]) => {
    if (!value || value.length < MIN_SECRET) return []
    if (!/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) return []
    if (value.startsWith("/") || /^(true|false|\d+)$/i.test(value)) return []
    return [{ value, kind: "env:" + name }]
  })
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function create(initial: Secret[] = []) {
  const known = new Map<string, string>()
  let literal: RegExp | undefined

  const rebuild = () => {
    const values = [...known.keys()].sort((a, b) => b.length - a.length)
    literal = values.length ? new RegExp(values.map(escape).join("|"), "g") : undefined
  }

  const add = (value: string, kind: string) => {
    if (value.length < MIN_SECRET || known.has(value)) return
    known.set(value, kind)
    rebuild()
  }
  for (const item of initial) add(item.value, item.kind)

  const scrub = (text: string) => {
    let out = text
    if (literal) out = out.replace(literal, (value) => mask(value, known.get(value) ?? "secret"))
    for (const shape of TOKEN_SHAPES)
      out = out.replace(shape.pattern, (value) =>
        // A key block ends in dashes; its last four characters say nothing.
        shape.kind === "private-key" ? "[redacted:private-key]" : mask(value, shape.kind),
      )
    out = out.replace(QUERY, (_all, name: string, value: string) => name + mask(value, "query"))
    out = out.replace(ASSIGNMENT, (all, lead: string, name: string, value: string) =>
      value.startsWith("[redacted:") ? all : `${lead}${name}=${mask(value, "assignment")}`,
    )
    out = out.replace(JSON_PAIR, (all, head: string, value: string, tail: string) =>
      value.startsWith("[redacted:") ? all : head + mask(value, "json") + tail,
    )
    return out
  }

  return { add, scrub }
}

export * as LogScrub from "./log-scrub"
