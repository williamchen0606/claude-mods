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

/** A usage level's color: the theme's success, warning or error. */
export type LevelColor = 'success' | 'warning' | 'error'

/**
 * One item of the status line: a dim label, then for a percentage its bar and
 * its percentage, then any text.
 */
export type Segment = {
  label?: string
  /** How full the bar is drawn, 0–100; absent for an item with no percentage. */
  bar?: number
  /** The bar's fill color. */
  barColor?: LevelColor
  /** The percentage as text: `34%`, `剩 66%`. */
  percent?: string
  text?: string
  color?: 'error' | 'warning'
}

/** How a percentage is drawn: as a bar, as text, or both. */
export type DisplayMode = 'both' | 'bar' | 'percent'

/** Whether percentages read as used (the default) or as what is left. */
export type PercentMode = 'used' | 'remaining'

/** What an item is drawn from. */
export type ItemContext = { usage: UsageSnapshot; now: number; percent: PercentMode }

function barColorOf(used: number): LevelColor {
  return levelColor(used) ?? 'success'
}

/** A percentage item with its bar: `5h 34%`, or with `remaining`, `5h 剩 66%`. */
function percentSegment(label: string, used: number, mode: PercentMode, text?: string): Segment {
  const shown = mode === 'remaining' ? Math.max(0, 100 - used) : used
  const segment: Segment = {
    label,
    bar: Math.min(100, Math.max(0, shown)),
    barColor: barColorOf(used),
    percent: `${mode === 'remaining' ? '剩 ' : ''}${shown}%`,
  }
  const color = levelColor(used)
  if (color) segment.color = color
  if (text !== undefined) segment.text = text
  return segment
}

function resetSegment(window: LimitWindow | undefined, now: number): Segment | undefined {
  if (window?.resetsAt === undefined) return undefined
  return { text: `${formatDuration(Math.max(0, window.resetsAt - now))} 後重置` }
}

/**
 * Every item the status line can show, by the id `items` names it with. Each
 * returns its segment, or undefined when it has nothing to show.
 */
export const ITEMS = {
  '5h': ({ usage, percent }) => usage.fiveHour && percentSegment('5h', usage.fiveHour.percent, percent),
  '5h-reset': ({ usage, now }) => resetSegment(usage.fiveHour, now),
  '5h-estimate': ({ usage, now }) => {
    if (!usage.fiveHour) return undefined
    const estimate = runOut(usage.fiveHour, usage.fiveHourRate, now)
    if (!estimate) return undefined
    if ('lasts' in estimate) return { text: '可撐到重置' }
    return estimate.runsOutIn === 0
      ? { text: '已用完', color: 'error' }
      : { text: `約 ${formatDuration(estimate.runsOutIn)} 後用完`, color: 'warning' }
  },
  '7d': ({ usage, percent }) => usage.sevenDay && percentSegment('7d', usage.sevenDay.percent, percent),
  '7d-reset': ({ usage, now }) => resetSegment(usage.sevenDay, now),
  context: ({ usage, percent }) => {
    if (!usage.context) return undefined
    const { percent: used, window } = usage.context
    return used === undefined
      ? { label: 'Context', text: `– / ${formatTokens(window)}` }
      : percentSegment('Context', used, percent, `/ ${formatTokens(window)}`)
  },
  cost: ({ usage }) => (usage.costUsd === undefined ? undefined : { text: formatUsd(usage.costUsd) }),
} satisfies Record<string, (context: ItemContext) => Segment | undefined>

export type ItemId = keyof typeof ITEMS

/** One line of the status line, as the items it shows in order. */
export type Line = ItemId[]

/** Draws a line's segments; `joined` marks a segment drawn after ` · ` rather than ` │ `. */
export type LineSegment = Segment & { joined: boolean }

/** Items of one family (`5h`, `5h-reset`, `5h-estimate`) read as one group. */
function familyOf(id: ItemId): string {
  return id.split('-')[0] ?? id
}

/**
 * The status line's lines, each the segments of its items in order; items
 * with nothing to show and lines left empty are dropped. A segment following
 * one of its own family is `joined` to it.
 */
export function statusLines(
  usage: UsageSnapshot,
  now: number,
  layout: readonly Line[],
  percent: PercentMode = 'used',
): LineSegment[][] {
  const context: ItemContext = { usage, now, percent }
  return layout
    .map(line => {
      const out: LineSegment[] = []
      let previous: ItemId | undefined
      for (const id of line) {
        const segment = ITEMS[id](context)
        if (!segment) continue
        out.push({ ...segment, joined: previous !== undefined && familyOf(previous) === familyOf(id) })
        previous = id
      }
      return out
    })
    .filter(line => line.length > 0)
}

/**
 * How many of a bar's `width` cells are filled at `percent`: rounded, but at
 * least one above 0 and at most `width - 1` below 100, so a little and nearly
 * all still read as such.
 */
export function filledCells(percent: number, width: number): number {
  if (percent <= 0) return 0
  if (percent >= 100) return width
  return Math.min(width - 1, Math.max(1, Math.round((percent / 100) * width)))
}

/** A segment as plain text, as the README shows it: `5h 34%`, `Context 42% / 200k`. */
export function segmentText(segment: Segment): string {
  return [segment.label, segment.percent, segment.text].filter(Boolean).join(' ')
}
