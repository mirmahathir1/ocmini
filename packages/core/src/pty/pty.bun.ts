import { spawn as create } from "bun-pty"
import type { Disp, Exit, Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

export function spawn(file: string, args: string[], opts: Opts): Proc {
  const pty = create(file, args, opts)

  // bun-pty starts its read loop inside the constructor and fires onExit from
  // there, but its emitter has no replay: a listener attached after the child
  // has already exited never hears about it. The loop polls every 8ms, so a
  // short-lived child plus a busy event loop loses the event outright. Latch it
  // here — synchronously, before spawn() returns — and replay to late listeners.
  let exit: Exit | undefined
  const listeners = new Set<(event: Exit) => void>()
  pty.onExit((event) => {
    exit = event
    for (const listener of listeners) listener(event)
    listeners.clear()
  })

  return {
    pid: pty.pid,
    onData(listener) {
      return pty.onData(listener)
    },
    onExit(listener): Disp {
      if (exit) {
        listener(exit)
        return { dispose() {} }
      }
      listeners.add(listener)
      return {
        dispose() {
          listeners.delete(listener)
        },
      }
    },
    write(data) {
      pty.write(data)
    },
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    kill(signal) {
      pty.kill(signal)
    },
  }
}
