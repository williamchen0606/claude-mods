import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { UsageSnapshot } from '../types'
import { fillRate, recordSample, snapshotOf, statusGroups } from './usage'
import type { SampleLog } from './usage'

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

  on('session.start', async ($, e, next) => {
    const result = await next(e)
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
    const groups = usage ? statusGroups(usage, (await read($, nowAtom)) || Date.now()) : []
    if (groups.length === 0) return below

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {groups.flatMap((group, g) => [
            ...(g > 0 ? [<Text key={`bar-${g}`} dimColor>│</Text>] : []),
            ...group.map((segment, s) => (
              <Text key={`seg-${g}-${s}`} color={segment.color} dimColor={!segment.color}>
                {s > 0 ? `· ${segment.text}` : segment.text}
              </Text>
            )),
          ])}
        </Box>
      </Box>
    )
  })
}
