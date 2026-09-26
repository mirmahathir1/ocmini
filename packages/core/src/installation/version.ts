import pkg from "../../package.json"

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

// Unbuilt runs fall back to the package version rather than "local": zen's free
// tier rejects a User-Agent of `opencode/local` as not coming from OpenCode.
export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : pkg.version
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
