// Pure helpers for the desktop-statusline mod: no `$`, so the tests import them directly.

import type { SessionRateLimit, SessionUsage } from 'claude-code'

import type { LimitWindow, UsageSnapshot } from '../types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The 5-hour window's length. */
export const FIVE_HOURS = 5 * HOUR
/** How far back a recent sample may be to measure the current pace. */
export const RECENT_SPAN = 30 * MINUTE
/** The shortest span a pace is measured over; shorter spans are too noisy. */
export const MIN_SPAN = 5 * MINUTE
/** How long samples are kept. */
export const SAMPLE_TTL = HOUR

/** One reading of the 5-hour window, kept to measure how fast it fills. */
export type Sample = { t: number; percent: number }

/** The samples of one 5-hour window, keyed by when it resets. */
export type SampleLog = { resetsAt: number; samples: Sample[] }

/** `1h20m`, `35m`, `3d4h`, `<1m`. */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return '<1m'
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY)
    const hours = Math.floor((ms % DAY) / HOUR)
    return hours > 0 ? `${days}d${hours}h` : `${days}d`
  }
  const hours = Math.floor(ms / HOUR)
  const minutes = Math.floor((ms % HOUR) / MINUTE)
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`
}

/** `200k`, `1M`. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  return `${Math.round(tokens / 1000)}k`
}

/** `$1.23`; `$0.004` shows as `<$0.01`. */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

function toWindow(limit: SessionRateLimit | undefined): LimitWindow | undefined {
  if (!limit) return undefined
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  return Number.isFinite(resetsAt) ? { percent: limit.percentUsed, resetsAt } : { percent: limit.percentUsed }
}

/** The figures the status line draws, read off `$.session.usage()` or a `session.measure` event. */
export function snapshotOf(usage: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): UsageSnapshot {
  const snapshot: UsageSnapshot = {}
  const fiveHour = toWindow(usage.rateLimits.find(l => l.kind === 'five_hour'))
  const sevenDay = toWindow(usage.rateLimits.find(l => l.kind === 'seven_day'))
  if (fiveHour) snapshot.fiveHour = fiveHour
  if (sevenDay) snapshot.sevenDay = sevenDay
  if (usage.context.window > 0) {
    snapshot.context =
      usage.context.percent === undefined
        ? { window: usage.context.window }
        : { percent: usage.context.percent, window: usage.context.window }
  }
  if (usage.cost) snapshot.costUsd = usage.cost.usd
  return snapshot
}

/**
 * Adds a reading of the 5-hour window to its log: starts a new log when the
 * window rolled over (its reset moved by more than ten minutes), drops
 * samples older than SAMPLE_TTL, and skips a reading equal to the last one.
 */
export function recordSample(log: SampleLog | null, window: LimitWindow, now: number): SampleLog | null {
  if (window.resetsAt === undefined) return log
  const isSameWindow = log !== null && Math.abs(log.resetsAt - window.resetsAt) <= 10 * MINUTE
  const kept = isSameWindow ? log.samples.filter(s => now - s.t <= SAMPLE_TTL) : []
  const last = kept[kept.length - 1]
  const samples = last && last.percent === window.percent ? kept : [...kept, { t: now, percent: window.percent }]
  return { resetsAt: window.resetsAt, samples }
}

/**
 * How fast the 5-hour window fills, in percent per millisecond: over the last
 * RECENT_SPAN when the log covers at least MIN_SPAN of it, else averaged over
 * the window so far. Undefined when neither can be measured or nothing was used.
 */
export function fillRate(window: LimitWindow, log: SampleLog | null, now: number): number | undefined {
  const recent = log?.samples.find(s => now - s.t <= RECENT_SPAN && s.percent <= window.percent)
  if (recent && now - recent.t >= MIN_SPAN) {
    const rate = (window.percent - recent.percent) / (now - recent.t)
    if (rate > 0) return rate
    // Nothing used lately: fall through to the window's average.
  }
  if (window.resetsAt === undefined || window.percent <= 0) return undefined
  const elapsed = now - (window.resetsAt - FIVE_HOURS)
  return elapsed >= MIN_SPAN ? window.percent / elapsed : undefined
}

/**
 * When the 5-hour window runs out at `rate`, against when it resets:
 * `{ runsOutIn }` (ms from now) when that comes first, `{ lasts: true }` when
 * the reset comes first, undefined when it cannot be told.
 */
export function runOut(
  window: LimitWindow,
  rate: number | undefined,
  now: number,
): { runsOutIn: number } | { lasts: true } | undefined {
  if (window.percent >= 100) return { runsOutIn: 0 }
  if (rate === undefined || rate <= 0) return undefined
  const runsOutIn = (100 - window.percent) / rate
  if (window.resetsAt !== undefined && now + runsOutIn >= window.resetsAt) return { lasts: true }
  return { runsOutIn }
}

/** The color a usage percentage is drawn in: warning from 70, error from 90. */
export function levelColor(percent: number): 'error' | 'warning' | undefined {
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'
  return undefined
}

/** One run of text in the status line, with its color. */
export type Segment = { text: string; color?: 'error' | 'warning' }

/** The status line's segments, in groups separated by a bar. */
export function statusGroups(usage: UsageSnapshot, now: number): Segment[][] {
  const groups: Segment[][] = []

  if (usage.fiveHour) {
    const w = usage.fiveHour
    const group: Segment[] = [{ text: `5h ${w.percent}%`, color: levelColor(w.percent) }]
    if (w.resetsAt !== undefined) group.push({ text: `${formatDuration(Math.max(0, w.resetsAt - now))} 後重置` })
    const estimate = runOut(w, usage.fiveHourRate, now)
    if (estimate && 'lasts' in estimate) group.push({ text: '可撐到重置' })
    else if (estimate) {
      group.push(
        estimate.runsOutIn === 0
          ? { text: '已用完', color: 'error' }
          : { text: `約 ${formatDuration(estimate.runsOutIn)} 後用完`, color: 'warning' },
      )
    }
    groups.push(group)
  }

  if (usage.sevenDay) {
    const w = usage.sevenDay
    const group: Segment[] = [{ text: `7d ${w.percent}%`, color: levelColor(w.percent) }]
    if (w.resetsAt !== undefined) group.push({ text: `${formatDuration(Math.max(0, w.resetsAt - now))} 後重置` })
    groups.push(group)
  }

  if (usage.context) {
    const { percent, window } = usage.context
    groups.push([
      percent === undefined
        ? { text: `Context – / ${formatTokens(window)}` }
        : { text: `Context ${percent}% / ${formatTokens(window)}`, color: levelColor(percent) },
    ])
  }

  if (usage.costUsd !== undefined) groups.push([{ text: formatUsd(usage.costUsd) }])

  return groups
}
