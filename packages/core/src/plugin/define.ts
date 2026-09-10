import type { Effect, Scope } from "effect"
// NOTE: type-only, so it is erased at runtime and does not need the removed
// @opencode-ai/plugin package to resolve. It stays dangling for typecheck
// until the plugin system itself is cut.
import type { PluginContext } from "@opencode-ai/plugin/v2/effect"

// Inlined from the removed @opencode-ai/plugin package. `define` is an
// identity function; it exists purely so plugin literals get contextually
// typed at their definition site.
export interface Plugin<R = Scope.Scope> {
  readonly id: string
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R>
}

export function define<R = Scope.Scope>(plugin: Plugin<R>) {
  return plugin
}
