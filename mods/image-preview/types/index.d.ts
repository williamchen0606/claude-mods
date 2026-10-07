/**
 * One `[Image #N]` in the prompt box and what the mod captured for it.
 *
 * `pending` while the capture runs; `ok` with a PNG on disk and its size;
 * `error` with a reason to show instead of the picture.
 */
export type Preview =
  | { id: number; status: 'pending' }
  | { id: number; status: 'ok'; path: string; width: number; height: number }
  | { id: number; status: 'error'; reason: string }

/**
 * The annotation window's bookkeeping (macOS only).
 *
 * `isMac` once `session.start` checked the system; `open` the id whose window
 * is up, if any; `repaste` the annotated PNG the mod is pasting back and until
 * when (epoch ms) a new `[Image #N]` counts as that paste, so its window does
 * not open again; `highestSeen` the highest id seen so far, as only a higher
 * one is a new paste.
 */
export type Annotation = {
  isMac: boolean
  open: number | null
  repaste: { path: string; until: number } | null
  highestSeen: number
}

declare module 'claude-code' {
  interface PluginState {
    'image-preview': { previews: Preview[]; annotation: Annotation }
  }
}
