import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Preview } from '../types'
import { FIND_SCRIPT, captureError, fitCells, imageIds, parseCapture } from './preview'

const previews = atom({ plugin: 'image-preview', key: 'previews' } as const, [] as Preview[])

/** How often the prompt box is checked for new or removed `[Image #N]`, in ms. */
const POLL_MS = 400

/** The tallest a preview is drawn, in terminal rows. */
const MAX_IMAGE_ROWS = 8

/** Only the PNGs this mod converted are its own to delete; Claude Code's stay. */
const OWN_FILES = '/claude-image-preview/'

function upsert(list: Preview[], preview: Preview): Preview[] {
  return [...list.filter(p => p.id !== preview.id), preview].sort((a, b) => a.id - b.id)
}

async function removeOwnFiles($: EngineInterface, gone: Preview[]) {
  const paths = gone.flatMap(p => (p.status === 'ok' && p.path.includes(OWN_FILES) ? [p.path] : []))
  if (paths.length > 0) await $.process.run(['rm', '-f', ...paths]).catch(() => {})
}

/** Looks up the file Claude Code stored for `[Image #id]` and records it. */
async function capture($: EngineInterface, id: number) {
  let preview: Preview
  try {
    const sessionId = await $.session.id()
    const { exitCode, stdout } = await $.process.run(['sh', '-c', FIND_SCRIPT, 'sh', sessionId, String(id)], {
      timeoutMs: 10_000,
    })
    const found = exitCode === 0 ? parseCapture(stdout) : null
    preview = found ? { id, status: 'ok', ...found } : { id, status: 'error', reason: captureError(exitCode) }
  } catch (error) {
    preview = { id, status: 'error', reason: `讀取失敗：${String(error)}` }
  }

  // The placeholder may have been deleted while the lookup ran.
  let isStale = false
  await update($, previews, list => {
    isStale = !(list ?? []).some(p => p.id === id)
    return isStale ? (list ?? []) : upsert(list ?? [], preview)
  })
  if (isStale) await removeOwnFiles($, [preview])
}

/** Brings the previews in line with the `[Image #N]` placeholders now in the prompt box. */
async function sync($: EngineInterface) {
  const { text } = await $.prompt.read()
  const ids = imageIds(text)
  const current = (await read($, previews)) ?? []

  const gone = current.filter(p => !ids.includes(p.id))
  const added = ids.filter(id => !current.some(p => p.id === id))
  if (gone.length === 0 && added.length === 0) return

  await update($, previews, list => [
    ...(list ?? []).filter(p => ids.includes(p.id)),
    ...added.map((id): Preview => ({ id, status: 'pending' })),
  ].sort((a, b) => a.id - b.id))
  void removeOwnFiles($, gone)
  for (const id of added) void capture($, id)
}

export const register: Register = on => {
  // Pasting an image does not raise prompt.edit, so the box is polled instead.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    let isSyncing = false
    $.clock.every(POLL_MS, () => {
      if (isSyncing) return
      isSyncing = true
      sync($)
        .catch(() => {})
        .finally(() => {
          isSyncing = false
        })
    })
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = (await read($, previews)) ?? []
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const label = (p: Preview) =>
      p.status === 'ok'
        ? `[Image #${p.id}] ${p.width}×${p.height}`
        : p.status === 'pending'
          ? `[Image #${p.id}] 讀取中…`
          : `[Image #${p.id}] ${p.reason}`

    if (e.surface !== 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {list.map(p => (
            <Text key={`label-${p.id}`} dimColor>
              {label(p)}（此介面無法預覽圖片，僅 Ghostty / kitty 終端機支援）
            </Text>
          ))}
        </Box>
      )
    }

    const { Box, Image, Text } = $.ui.resolve(e)
    const rows = Math.max(1, Math.min(MAX_IMAGE_ROWS, e.props.maxRows - 2))
    const maxColumns = Math.max(4, Math.floor(e.props.bodyColumns / Math.max(1, list.length)) - 2)

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {list.map(p => (
          <Box key={`preview-${p.id}`} flexDirection="column">
            {p.status === 'ok' ? (
              <Image
                key={`image-${p.id}`}
                source={{ file: p.path, format: 'png' }}
                {...fitCells(p.width, p.height, maxColumns, rows)}
                alt={`[Image #${p.id}]（這個終端機無法顯示圖片）`}
              />
            ) : null}
            <Text dimColor wrap="truncate-end">
              {label(p)}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
