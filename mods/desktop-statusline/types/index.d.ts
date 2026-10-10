/** One rate-limit window: how much of it is used, and when it resets (epoch ms). */
export type LimitWindow = { percent: number; resetsAt?: number }

/** The figures the status line draws, as of the last measurement. */
export type UsageSnapshot = {
  fiveHour?: LimitWindow
  sevenDay?: LimitWindow
  context?: { percent?: number; window: number }
  costUsd?: number
  /** How fast the 5-hour window is filling, in percent per millisecond; absent when unknown. */
  fiveHourRate?: number
}

declare module 'claude-code' {
  interface PluginState {
    'desktop-statusline': {
      usage: UsageSnapshot | null
      now: number
      /** The lines and their item ids, as the editor last saved them; null until read from the store. */
      layout: string[][] | null
      /** The line the editor is editing, or null on its overview. */
      editing: number | null
    }
  }
}
