import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { UsageSnapshot } from '../types'
import { filledCells, fillRate, parseItems, recordSample, snapshotOf, statusGroups } from './usage'
import type { DisplayMode, PercentMode, SampleLog, Segment } from './usage'

const usageAtom = atom({ plugin: 'desktop-statusline', key: 'usage' } as const, null as UsageSnapshot | null)
const nowAtom = atom({ plugin: 'desktop-statusline', key: 'now' } as const, 0)

/** How often the countdowns are redrawn and the figures re-read, in ms. */
const TICK_MS = 30_000

/** The `$.store` key of the 5-hour window's samples; the window is the account's, so they outlive a session. */
const SAMPLES_KEY = 'five-hour-samples'

function isSampleLog(value: unknown): value is SampleLog {
  return typeof value === 'object' && value !== null && 'resetsAt' in value && Array.isArray((value as SampleLog).samples)
}

/** Reads the figures, logs the 5-hour window's reading, and stores what the status line draws. */
async function refresh($: EngineInterface, usage?: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>) {
  const now = await $.clock.now()
  const snapshot = snapshotOf(usage ?? (await $.session.usage()))

  if (snapshot.fiveHour) {
    const stored = await $.store.get(SAMPLES_KEY)
    const log = recordSample(isSampleLog(stored) ? stored : null, snapshot.fiveHour, now)
    if (log) await $.store.set(SAMPLES_KEY, log)
    const rate = fillRate(snapshot.fiveHour, log, now)
    if (rate !== undefined) snapshot.fiveHourRate = rate
  }

  await update($, usageAtom, () => snapshot)
  await update($, nowAtom, () => now)
}

export const register: Register = (on, options) => {
  const showInTerminal = options.showInTerminal === true
  const { groups: items, unknown } = parseItems(typeof options.items === 'string' ? options.items : undefined)
  const percent: PercentMode = options.percent === 'remaining' ? 'remaining' : 'used'
  const display: DisplayMode = options.display === 'bar' || options.display === 'percent' ? options.display : 'both'
  const barWidth =
    typeof options.barWidth === 'number' && Number.isFinite(options.barWidth)
      ? Math.min(40, Math.max(3, Math.round(options.barWidth)))
      : 10

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (unknown.length > 0) $.ui.log(`unknown items ignored: ${unknown.join(', ')}`)
    await refresh($).catch(() => {})
    $.clock.every(TICK_MS, () => {
      refresh($).catch(() => {})
    })
    return result
  })

  // Pushed after each turn, and when a rate-limit window moves a whole point.
  on('session.measure', async ($, e, next) => {
    await refresh($, e).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || (e.surface === 'terminal' && !showInTerminal)) return below

    const usage = await read($, usageAtom)
    const groups = usage ? statusGroups(usage, (await read($, nowAtom)) || Date.now(), items, percent) : []
    if (groups.length === 0) return below

    const { Box, Text } = $.ui.resolve(e)
    const item = (segment: Segment, key: string) => (
      <Box key={key} flexDirection="row" alignItems="center" columnGap={1}>
        {segment.label ? <Text dimColor>{segment.label}</Text> : null}
        {segment.bar !== undefined && display !== 'percent' ? (
          <Box width={barWidth} height={1} backgroundColor="subtle">
            <Box width={filledCells(segment.bar, barWidth)} height={1} backgroundColor={segment.barColor ?? 'success'} />
          </Box>
        ) : null}
        {segment.percent !== undefined && display !== 'bar' ? <Text color={segment.color}>{segment.percent}</Text> : null}
        {segment.text !== undefined ? (
          <Text color={segment.percent === undefined ? segment.color : undefined} dimColor={!segment.color || segment.percent !== undefined}>
            {segment.text}
          </Text>
        ) : null}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {groups.flatMap((group, g) => [
            ...(g > 0 ? [<Text key={`bar-${g}`} dimColor>│</Text>] : []),
            ...group.flatMap((segment, s) => [
              ...(s > 0 ? [<Text key={`dot-${g}-${s}`} dimColor>·</Text>] : []),
              item(segment, `seg-${g}-${s}`),
            ]),
          ])}
        </Box>
      </Box>
    )
  })
}
