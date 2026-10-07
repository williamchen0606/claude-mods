import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Annotation, Preview } from '../types'
import {
  BUILD_SCRIPT,
  FIND_SCRIPT,
  buildError,
  captureError,
  clickedId,
  fitCells,
  imageIds,
  parseCapture,
  helperPid,
  parseEdit,
  splitAtTag,
  pasteReason,
} from './preview'

const previews = atom({ plugin: 'image-preview', key: 'previews' } as const, [] as Preview[])
const annotation = atom(
  { plugin: 'image-preview', key: 'annotation' } as const,
  { isMac: false, open: null, repaste: null, highestSeen: 0 } as Annotation,
)

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

/** How many times a lookup is tried before its failure is shown, and the wait between tries. */
const LOOKUP_TRIES = 5
const LOOKUP_RETRY_MS = 500

/** How long after pasting an annotated image back a new `[Image #N]` counts as that paste, in ms. */
const REPASTE_MS = 120_000

/** How long to wait for Claude Code to take the pasted image in, in ms. */
const PASTE_WAIT_MS = 5_000

/** Annotation windows open one at a time, in the order they were asked for. */
let windows: Promise<void> = Promise.resolve()

function queueAnnotation($: EngineInterface, id: number) {
  windows = windows.then(() => annotate($, id)).catch(error => {
    $.ui.log(`image-preview: annotate [Image #${id}] failed: ${String(error)}`, { to: 'debug' })
  })
}

/**
 * Opens the annotation window over `[Image #id]`. Done swaps the placeholder
 * for the annotated image: the old one is taken out of the prompt box and the
 * new one pasted in (or left on the clipboard for the person to paste).
 */
async function annotate($: EngineInterface, id: number) {
  if (!(await read($, annotation)).isMac) return
  const preview = ((await read($, previews)) ?? []).find(p => p.id === id)
  if (preview?.status !== 'ok') return
  if (!imageIds((await $.prompt.read()).text).includes(id)) return

  await update($, annotation, a => ({ ...a, open: id }))
  try {
    const built = await $.process.run(
      ['sh', '-c', BUILD_SCRIPT, 'sh', `${$.plugin.root}/helper/annotate.swift`],
      { timeoutMs: 300_000 },
    )
    if (built.exitCode !== 0) {
      $.ui.log(`image-preview: build exit ${built.exitCode}: ${built.stderr.slice(0, 200)}`, { to: 'debug' })
      $.ui.toast(`image-preview：${buildError(built.exitCode)}`)
      return
    }
    const [bin = '', dir = ''] = built.stdout.split('\n')
    const out = `${dir}/${await $.session.id()}-${id}-annotated-${await $.clock.now()}.png`

    let stdout = ''
    for await (const chunk of $.process.spawn({ argv: [bin, 'edit', preview.path, out, `[Image #${id}]`] })) {
      if (chunk.stream === 'stdout') stdout += chunk.text
      else $.ui.log(`image-preview: annotate: ${chunk.text.slice(0, 200)}`, { to: 'debug' })
    }
    const edit = parseEdit(stdout)
    if (!edit.saved) return

    const { text } = await $.prompt.read()
    if (!imageIds(text).includes(id)) {
      $.ui.toast(`image-preview：[Image #${id}] 已不在輸入框，沒有替換`)
      await removeOwnFiles($, [{ ...preview, path: out }])
      return
    }
    // Claude Code pastes at the cursor, and a fill leaves the cursor at the
    // end, so keep only what came before the placeholder while the image is
    // pasted, then put the rest back after it.
    const { before, after } = splitAtTag(text, id)
    const highest = Math.max(id, ...imageIds(text))
    const until = (await $.clock.now()) + REPASTE_MS
    await update($, annotation, a => ({ ...a, repaste: { path: out, until } }))
    const filled = await $.prompt.fill({ text: before, mode: 'replace' })
    if (!filled.isFilled) {
      await update($, annotation, a => ({ ...a, repaste: null }))
      $.ui.toast('image-preview：無法修改輸入框，標註圖沒有放回去')
      return
    }
    // From here on the rest of the prompt is out of the box: whatever
    // happens, it goes back exactly once.
    let isRestBack = false
    const putBackRest = async () => {
      if (isRestBack) return
      isRestBack = true
      if (after) await $.prompt.fill({ text: after, mode: 'append' })
    }
    try {
      const helper = $.process.spawn({ argv: [bin, 'paste', out, String(edit.terminal)] })
      let outcome = ''
      while (!outcome.includes('\n')) {
        const piece = await helper.next()
        if (piece.done) break
        if (piece.value.stream === 'stdout') outcome += piece.value.text
        else $.ui.log(`image-preview: paste: ${piece.value.text.slice(0, 200)}`, { to: 'debug' })
      }
      // The helper stays on to put the clipboard back once told to.
      void (async () => {
        for await (const _ of helper);
      })().catch(() => {})
      outcome = outcome.trim()
      $.ui.log(`image-preview: paste: ${outcome}`, { to: 'debug' })
      if (!outcome.startsWith('pasted')) {
        await putBackRest()
        $.ui.toast(`image-preview：標註後的圖片已複製，按 Ctrl+V 貼回輸入框（${pasteReason(outcome)}）`)
        return
      }

      let isIn = false
      for (let waited = 0; waited < PASTE_WAIT_MS && !isIn; waited += 100) {
        await $.clock.sleep(100)
        isIn = imageIds((await $.prompt.read()).text).some(n => n > highest)
      }
      await putBackRest()
      const pid = helperPid(outcome)
      if (!isIn) {
        $.ui.toast('image-preview：沒看到圖片貼回來，標註圖還在剪貼簿，可以按 Ctrl+V 貼上')
      } else if (pid) {
        await $.process.run(['kill', '-USR1', String(pid)]).catch(() => {})
      }
    } finally {
      await putBackRest()
    }
  } finally {
    await update($, annotation, a => ({ ...a, open: null }))
  }
}

/** Looks up the file Claude Code stored for `[Image #id]` and records it. */
async function capture($: EngineInterface, id: number, shouldAnnotate: boolean) {
  let preview: Preview = { id, status: 'error', reason: captureError(-1) }
  for (let attempt = 1; attempt <= LOOKUP_TRIES; attempt++) {
    try {
      const sessionId = await $.session.id()
      const { exitCode, stdout, stderr } = await $.process.run(
        ['sh', '-c', FIND_SCRIPT, 'sh', sessionId, String(id)],
        { timeoutMs: 10_000 },
      )
      const found = exitCode === 0 ? parseCapture(stdout) : null
      if (found) {
        preview = { id, status: 'ok', ...found }
        break
      }
      const output = `stdout=${JSON.stringify(stdout.slice(0, 200))} stderr=${JSON.stringify(stderr.slice(0, 200))}`
      $.ui.log(`image-preview: [Image #${id}] try ${attempt}: exit ${exitCode} ${output}`, { to: 'debug' })
      preview = {
        id,
        status: 'error',
        reason: exitCode === 0 ? `無法解析輸出：${JSON.stringify(stdout.trim().slice(0, 80))}` : captureError(exitCode),
      }
    } catch (error) {
      preview = { id, status: 'error', reason: `讀取失敗：${String(error)}` }
    }
    if (attempt < LOOKUP_TRIES) await $.clock.sleep(LOOKUP_RETRY_MS)
  }

  // The placeholder may have been deleted while the lookup ran.
  let isStale = false
  await update($, previews, list => {
    isStale = !(list ?? []).some(p => p.id === id)
    return isStale ? (list ?? []) : upsert(list ?? [], preview)
  })
  if (isStale) await removeOwnFiles($, [preview])
  else if (shouldAnnotate && preview.status === 'ok') queueAnnotation($, id)
}

/** Brings the previews in line with the `[Image #N]` placeholders now in the prompt box. */
async function sync($: EngineInterface, autoAnnotate: boolean) {
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

  // A placeholder that appears right after an annotated image was pasted back
  // is that paste: its window does not open again.
  // A placeholder seen before (one the mod took out and put back) does not
  // open it either: Claude Code numbers pastes upwards, so only ids above
  // the highest seen are new.
  const { repaste, highestSeen } = await read($, annotation)
  const fresh = added.filter(id => id > highestSeen)
  let isRepaste = false
  if (fresh.length > 0 && repaste) {
    isRepaste = (await $.clock.now()) < repaste.until
    if (isRepaste) void removeOwnFiles($, [{ id: 0, status: 'ok', path: repaste.path, width: 1, height: 1 }])
  }
  if (fresh.length > 0) {
    await update($, annotation, a => ({
      ...a,
      highestSeen: Math.max(a.highestSeen, ...fresh),
      repaste: repaste ? null : a.repaste,
    }))
  }
  for (const id of added) void capture($, id, autoAnnotate && !isRepaste && fresh.includes(id))
}

export const register: Register = (on, options) => {
  const autoAnnotate = options.autoAnnotate !== false

  // Pasting an image does not raise prompt.edit, so the box is polled instead.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const uname = await $.process.run(['uname', '-s']).catch(() => null)
    const isMac = uname?.stdout.trim() === 'Darwin'
    await update($, annotation, a => ({ ...a, isMac, open: null }))
    let isSyncing = false
    $.clock.every(POLL_MS, () => {
      if (isSyncing) return
      isSyncing = true
      sync($, autoAnnotate)
        .catch(() => {})
        .finally(() => {
          isSyncing = false
        })
    })
    return result
  })

  // A click on a picture, from the region click.tsx lays over it.
  on('ui.message', async ($, e, next) => {
    const id = clickedId(e.data)
    if (e.module.endsWith('click.tsx') && id !== null) queueAnnotation($, id)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Draw below what other plugins and the engine put in the band, not instead of it.
    const below = await next(e)
    const list = (await read($, previews)) ?? []
    if (e.props.hasSurvey || list.length === 0) return below
    const { isMac, open } = await read($, annotation)

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
          {below}
          {list.map(p => (
            <Text key={`label-${p.id}`} dimColor>
              {label(p)}（此介面無法預覽圖片，僅 Ghostty / kitty 終端機支援）
            </Text>
          ))}
        </Box>
      )
    }

    const { Box, Button, Client, Image, Text } = $.ui.resolve(e)
    const rows = Math.max(1, Math.min(MAX_IMAGE_ROWS, e.props.maxRows - 2))
    const maxColumns = Math.max(4, Math.floor(e.props.bodyColumns / Math.max(1, list.length)) - 2)

    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {list.map(p => (
            <Box key={`preview-${p.id}`} flexDirection="column">
              {p.status === 'ok' ? (
                <Box key={`frame-${p.id}`}>
                  <Image
                    key={`image-${p.id}`}
                    source={{ file: p.path, format: 'png' }}
                    {...fitCells(p.width, p.height, maxColumns, rows)}
                    alt={`[Image #${p.id}]（這個終端機無法顯示圖片）`}
                  />
                  {isMac ? (
                    // An empty region laid over the picture, so a click on it opens the window.
                    <Box position="absolute" top={0} left={0}>
                      <Client
                        key={`click-${p.id}`}
                        module="./click.tsx"
                        props={{ id: p.id }}
                        width={fitCells(p.width, p.height, maxColumns, rows).columns}
                        height={fitCells(p.width, p.height, maxColumns, rows).rows}
                      />
                    </Box>
                  ) : null}
                </Box>
              ) : null}
              {isMac && p.status === 'ok' ? (
                <Button
                  key={`annotate-${p.id}`}
                  plain
                  dimColor
                  label={open === p.id ? `${label(p)} 標註中…` : `${label(p)} ✎ 標註`}
                  onPress={() => queueAnnotation($, p.id)}
                />
              ) : (
                <Text dimColor wrap="truncate-end">
                  {label(p)}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
