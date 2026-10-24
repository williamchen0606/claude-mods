/** The devflow progress file, `.devflow/state.json` under the project root, as the skills write it. */
export type StageStatus = 'pending' | 'active' | 'done' | 'skipped'

export type Stage = {
  name: string
  status: StageStatus
  /** A few words shown beside the stage: a slice count, a skip reason. */
  note?: string
}

export type Progress = {
  track: string
  size: string
  /** A few words naming the task. */
  task?: string
  stages: Stage[]
  /** Path of the spec file, when the work has one. */
  spec?: string
}

declare module 'claude-code' {
  interface PluginState {
    devflow: {
      /** What the progress file last held; null when there is none or it does not parse. */
      progress: Progress | null
      /** The file's mtime when it was last read, so a poll re-reads only on change. */
      mtimeMs: number
      /** Whether the person hid the band until the file next changes. */
      isHidden: boolean
      /** When this session started, so a finished file from an earlier session is not shown. */
      sessionStartedMs: number
    }
  }
}
