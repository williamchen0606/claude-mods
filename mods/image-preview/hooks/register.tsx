import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Preview } from '../types'
import { CAPTURE_SCRIPT, captureError, droppedImagePath, fitCells, imageIds, parseCapture } from './preview'

const previews = atom({ plugin: 'image-preview', key: 'previews' } as const, [] as Preview[])

/** The tallest a preview is drawn, in terminal rows. */
const MAX_IMAGE_ROWS = 8

function upsert(list: Preview[], preview: Preview): Preview[] {
  return [...list.filter(p => p.id !== preview.id), preview].sort((a, b) => a.id - b.id)
}

async function removeFiles($: EngineInterface, gone: Preview[]) {
  const paths = gone.flatMap(p => (p.status === 'ok' ? [p.path] : []))
  if (paths.length > 0) await $.process.run(['rm', '-f', ...paths]).catch(() => {})
}

/** Captures the image behind `[Image #id]`: the dropped file when there is one, else the clipboard. */
async function capture($: EngineInterface, id: number, droppedPath: string | null) {
  await update($, previews, list => upsert(list ?? [], { id, status: 'pending' }))

  const name = `${crypto.randomUUID()}-${id}`
  const argv = droppedPath
    ? ['sh', '-c', CAPTURE_SCRIPT, 'sh', 'file', name, droppedPath]
    : ['sh', '-c', CAPTURE_SCRIPT, 'sh', 'clipboard', name]

  let preview: Preview
  try {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 10_000 })
    const captured = exitCode === 0 ? parseCapture(stdout) : null
    preview = captured
      ? { id, status: 'ok', ...captured }
      : { id, status: 'error', reason: captureError(exitCode) }
  } catch (error) {
    preview = { id, status: 'error', reason: `擷取失敗：${String(error)}` }
  }

  // The placeholder may have been deleted while the capture ran.
  let isStale = false
  await update($, previews, list => {
    isStale = !(list ?? []).some(p => p.id === id)
    return isStale ? (list ?? []) : upsert(list ?? [], preview)
  })
  if (isStale) await removeFiles($, [preview])
}

export const register: Register = on => {
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    const ids = imageIds(box.text)
    const current = (await read($, previews)) ?? []

    const gone = current.filter(p => !ids.includes(p.id))
    if (gone.length > 0) {
      await update($, previews, list => (list ?? []).filter(p => ids.includes(p.id)))
      void removeFiles($, gone)
    }

    // New placeholders: captured in the background so the edit is not held up.
    const added = ids.filter(id => !current.some(p => p.id === id))
    const droppedPath = droppedImagePath(e.inputText)
    for (const id of added) void capture($, id, added.length === 1 ? droppedPath : null)

    return box
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const current = (await read($, previews)) ?? []
    if (current.length > 0) {
      await update($, previews, () => [])
      void removeFiles($, current)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = (await read($, previews)) ?? []
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const label = (p: Preview) =>
      p.status === 'ok'
        ? `[Image #${p.id}] ${p.width}×${p.height}`
        : p.status === 'pending'
          ? `[Image #${p.id}] 擷取中…`
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
