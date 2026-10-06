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

declare module 'claude-code' {
  interface PluginState {
    'image-preview': { previews: Preview[] }
  }
}
