import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Progress } from '../types'
import { PROGRESS_FILE, detailText, fit, isLeftover, parseProgress, plainText, stageSegments, width } from './band'

const progressAtom = atom({ plugin: 'devflow', key: 'progress' } as const, null as Progress | null)
const mtimeAtom = atom({ plugin: 'devflow', key: 'mtimeMs' } as const, 0)
const hiddenAtom = atom({ plugin: 'devflow', key: 'isHidden' } as const, false)
const startedAtom = atom({ plugin: 'devflow', key: 'sessionStartedMs' } as const, 0)

/** How often the progress file is checked for a change, in ms; a tool call also checks it right away. */
const POLL_MS = 1_500

/** The command that shows, hides or clears the band. */
const COMMAND = 'devflow-band'

/** The skills write the file under the project root, the directory the session started in. */
async function progressPath($: EngineInterface) {
  return `${await $.session.root()}/${PROGRESS_FILE}`
}

/**
 * Re-reads the progress file when its mtime moved. A file that went away
 * blanks the band, and so does a finished route an earlier session left
 * behind; a file that changed also brings a hidden band back, since new
 * progress is what the person hid it until.
 */
async function refresh($: EngineInterface) {
  const path = await progressPath($)
  const stat = await $.fs.stat(path).catch(() => null)
  if (!stat) {
    if ((await read($, progressAtom)) !== null) {
      await update($, progressAtom, () => null)
      await update($, mtimeAtom, () => 0)
    }
    return
  }
  if (stat.mtimeMs === (await read($, mtimeAtom))) return
  const text = await $.fs.read(path).catch(() => '')
  const parsed = parseProgress(text)
  const progress = parsed && isLeftover(parsed, stat.mtimeMs, await read($, startedAtom)) ? null : parsed
  await update($, mtimeAtom, () => stat.mtimeMs)
  await update($, progressAtom, () => progress)
  if (progress) await update($, hiddenAtom, () => false)
}

/** One check at a time: a slow read must not pile up behind the timer. */
let isRefreshing = false

function poll($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  refresh($)
    .catch(error => $.ui.log(`devflow: progress file: ${String(error)}`, { to: 'debug' }))
    .finally(() => {
      isRefreshing = false
    })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // A hot reload runs session.start again: keep the first start, which $.state still holds.
    if ((await read($, startedAtom)) === 0) {
      const now = await $.clock.now()
      await update($, startedAtom, () => now)
    }
    await $.command.register({ name: COMMAND, description: '顯示、隱藏或清除 devflow 的進度列（show | hide | clear）' })
    poll($)
    $.clock.every(POLL_MS, () => poll($))
    return result
  })

  // The skills write the file with Write or a shell command: check it as soon as any tool returns.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    poll($)
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await $.process.run(['rm', '-f', await progressPath($)]).catch(() => {})
      await update($, progressAtom, () => null)
      await update($, mtimeAtom, () => 0)
      return { text: '已清除進度檔，進度列會在下一次 /devflow:go 時再出現。' }
    }
    if (arg === 'show' || arg === 'hide') {
      await update($, hiddenAtom, () => arg === 'hide')
      return { text: arg === 'hide' ? '進度列已隱藏，進度檔有變動時會再出現。' : '進度列已顯示。' }
    }
    const progress = await read($, progressAtom)
    if (!progress) return { text: '目前沒有進度（還沒跑 /devflow:go）。用法：/devflow-band show | hide | clear' }
    const detail = detailText(progress)
    return { text: [plainText(progress), detail, progress.spec ? `spec：${progress.spec}` : undefined].filter(Boolean).join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Draw below what other plugins and the engine put in the band, not instead of it.
    const below = await next(e)
    const progress = await read($, progressAtom)
    if (e.props.hasSurvey || progress === null || (await read($, hiddenAtom))) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = Math.max(10, e.props.bodyColumns - 8)
    const detail = detailText(progress)
    const line = plainText(progress)
    const hide = <Button key="hide" label="隱藏" plain dimColor onPress={() => void update($, hiddenAtom, () => true)} />
    const row =
      width(line) > columns ? (
        <Text>{fit(line, columns)}</Text>
      ) : (
        <Box flexDirection="row">
          {stageSegments(progress).map((s, i) => (
            <Text key={`seg-${i}`} dimColor={s.tone === 'dim'} bold={s.tone === 'bright'}>
              {s.text}
            </Text>
          ))}
        </Box>
      )
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" columnGap={1}>
          {row}
          {hide}
        </Box>
        {detail ? <Text dimColor>{fit(detail, columns)}</Text> : null}
      </Box>
    )
  })
}
