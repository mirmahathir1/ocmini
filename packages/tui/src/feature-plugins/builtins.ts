import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

export type BuiltinTuiPlugin = Omit<TuiPluginModule, "id"> & {
  id: string
  tui: TuiPlugin
  enabled?: boolean
}
