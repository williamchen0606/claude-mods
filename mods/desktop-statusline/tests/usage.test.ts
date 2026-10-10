import type { RenderElement } from 'claude-code'
import type { TestBody } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import {
  FIVE_HOURS,
  fillRate,
  formatDuration,
  formatTokens,
  filledCells,
  formatUsd,
  parseItems,
  recordSample,
  runOut,
  segmentText,
  snapshotOf,
  statusGroups,
} from '../hooks/usage'

const MIN = 60_000
const HOUR = 60 * MIN

describe('formatting', () => {
  test('durations', () => {
    expect(formatDuration(30_000)).toBe('<1m')
    expect(formatDuration(35 * MIN)).toBe('35m')
    expect(formatDuration(80 * MIN)).toBe('1h20m')
    expect(formatDuration(76 * HOUR)).toBe('3d4h')
    expect(formatDuration(48 * HOUR)).toBe('2d')
  })

  test('tokens and dollars', () => {
    expect(formatTokens(200_000)).toBe('200k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatUsd(1.234)).toBe('$1.23')
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(0)).toBe('$0.00')
  })
})

test('snapshotOf picks the 5-hour and 7-day windows, context and cost', () => {
  const snapshot = snapshotOf({
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-06T18:00:00Z' },
      { kind: 'seven_day', percentUsed: 12 },
      { kind: 'spend_limit', percentUsed: 50 },
    ],
    cost: { usd: 1.5 },
  })
  expect(snapshot).toEqual({
    fiveHour: { percent: 34, resetsAt: Date.parse('2026-10-06T18:00:00Z') },
    sevenDay: { percent: 12 },
    context: { percent: 42, window: 200_000 },
    costUsd: 1.5,
  })
})

describe('the 5-hour estimate', () => {
  const resetsAt = 10 * HOUR

  test('recordSample keeps one window, drops old and repeated readings', () => {
    let log = recordSample(null, { percent: 10, resetsAt }, 0)
    log = recordSample(log, { percent: 10, resetsAt }, MIN)
    log = recordSample(log, { percent: 12, resetsAt }, 2 * HOUR)
    expect(log).toEqual({ resetsAt, samples: [{ t: 2 * HOUR, percent: 12 }] })

    // The window rolled over: a new log.
    expect(recordSample(log, { percent: 1, resetsAt: resetsAt + FIVE_HOURS }, 2 * HOUR + MIN)).toEqual({
      resetsAt: resetsAt + FIVE_HOURS,
      samples: [{ t: 2 * HOUR + MIN, percent: 1 }],
    })
  })

  test('fillRate prefers the recent pace', () => {
    const now = 7 * HOUR
    const log = { resetsAt, samples: [{ t: now - 20 * MIN, percent: 40 }] }
    // 10 points in 20 minutes.
    expect(fillRate({ percent: 50, resetsAt }, log, now)).toBe(10 / (20 * MIN))
  })

  test('fillRate falls back to the window average', () => {
    // The window started at 5h; 2 hours in, 40 % used.
    expect(fillRate({ percent: 40, resetsAt }, null, 7 * HOUR)).toBe(40 / (2 * HOUR))
    expect(fillRate({ percent: 0, resetsAt }, null, 7 * HOUR)).toBeUndefined()
  })

  test('runOut compares running out with the reset', () => {
    const now = 7 * HOUR
    // 50 points left at 30 % an hour: out in 100 minutes, before the reset in 3 hours.
    expect(runOut({ percent: 50, resetsAt }, 30 / HOUR, now)).toEqual({ runsOutIn: 100 * MIN })
    // At 10 % an hour it lasts.
    expect(runOut({ percent: 50, resetsAt }, 10 / HOUR, now)).toEqual({ lasts: true })
    expect(runOut({ percent: 100, resetsAt }, undefined, now)).toEqual({ runsOutIn: 0 })
    expect(runOut({ percent: 50, resetsAt }, undefined, now)).toBeUndefined()
  })
})

const sample = {
  fiveHour: { percent: 75, resetsAt: 10 * HOUR },
  fiveHourRate: 30 / HOUR,
  sevenDay: { percent: 12, resetsAt: 7 * HOUR + 76 * HOUR },
  context: { percent: 42, window: 200_000 },
  costUsd: 1.234,
}

const lineOf = (groups: ReturnType<typeof statusGroups>) => groups.map(group => group.map(segmentText).join(' · '))

test('statusGroups reads as one line', () => {
  expect(lineOf(statusGroups(sample, 7 * HOUR))).toEqual([
    '5h 75% · 3h00m 後重置 · 約 50m 後用完',
    '7d 12% · 3d4h 後重置',
    'Context 42% / 200k',
    '$1.23',
  ])
})

test('percentages carry a bar colored by how much is used', () => {
  const groups = statusGroups(sample, 7 * HOUR)
  const fiveHour = groups[0]?.[0]
  const sevenDay = groups[1]?.[0]
  expect(fiveHour).toMatchObject({ bar: 75, barColor: 'warning', color: 'warning' })
  expect(sevenDay).toMatchObject({ bar: 12, barColor: 'success' })
})

test('remaining percentages drain the bar but keep the used level\'s color', () => {
  const groups = statusGroups(sample, 7 * HOUR, parseItems('5h | context').groups, 'remaining')
  expect(lineOf(groups)).toEqual(['5h 剩 25%', 'Context 剩 58% / 200k'])
  expect(groups[0]?.[0]).toMatchObject({ bar: 25, barColor: 'warning' })
})

test('filledCells keeps a little and nearly all visible', () => {
  expect(filledCells(0, 10)).toBe(0)
  expect(filledCells(4, 10)).toBe(1)
  expect(filledCells(34, 10)).toBe(3)
  expect(filledCells(98, 10)).toBe(9)
  expect(filledCells(100, 10)).toBe(10)
})

describe('parseItems', () => {
  test('reads groups and order', () => {
    expect(parseItems(' context ,COST | 5h ').groups).toEqual([['context', 'cost'], ['5h']])
    expect(lineOf(statusGroups(sample, 7 * HOUR, parseItems('cost | 5h, 5h-reset').groups))).toEqual([
      '$1.23',
      '5h 75% · 3h00m 後重置',
    ])
  })

  test('sets unknown ids apart, and falls back to the default with none known', () => {
    expect(parseItems('5h, nope | |').groups).toEqual([['5h']])
    expect(parseItems('5h, nope').unknown).toEqual(['nope'])
    expect(parseItems('').groups).toEqual(parseItems(undefined).groups)
    expect(parseItems('nope').groups.flat()).toEqual(['5h', '5h-reset', '5h-estimate', '7d', '7d-reset', 'context', 'cost'])
  })

  test('items with nothing to show drop out, and so do their groups', () => {
    expect(lineOf(statusGroups({ costUsd: 0.5 }, 0, parseItems('5h, 5h-reset | cost').groups))).toEqual(['$0.50'])
  })
})

test('draws the line on desktop, and on the terminal only when asked', async ($, on) => {
  mock.clock(on, { now: 7 * HOUR })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }) as unknown as RenderElement)

  await $.session.measure({
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 34, resetsAt: new Date(10 * HOUR).toISOString() }],
    cost: { usd: 1.5 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  const props = {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  }
  const desktop = JSON.stringify(
    await (await $.ui.mount({ plugin: 'desktop-statusline', surface: 'desktop', component: 'AbovePrompt', props })).drawn(),
  )
  expect(desktop).toMatch('engine')
  expect(desktop).toMatch('["34%"]')
  expect(desktop).toMatch('"width":3,"height":1,"backgroundColor":"success"')
  expect(desktop).toMatch('/ 200k')
  expect(desktop).toMatch('$1.50')

  const terminal = JSON.stringify(
    await (await $.ui.mount({ plugin: 'desktop-statusline', surface: 'terminal', component: 'AbovePrompt', props })).drawn(),
  )
  expect(terminal).toMatch('engine')
  expect(terminal).not.toMatch('34%')
})

test('draws on the terminal when showInTerminal is on', { options: { showInTerminal: true } }, async ($, on) => {
  mock.clock(on, { now: 7 * HOUR })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }) as unknown as RenderElement)

  await $.session.measure({
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [],
    changed: ['context'],
  })
  const ui = await $.ui.mount({
    plugin: 'desktop-statusline',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(JSON.stringify(await ui.drawn())).toMatch('["42%"]')
})

const props = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} }

async function drawn(...[$, on]: Parameters<TestBody>) {
  mock.clock(on, { now: 7 * HOUR })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }) as unknown as RenderElement)
  await $.session.measure({
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 34, resetsAt: new Date(10 * HOUR).toISOString() }],
    cost: { usd: 1.5 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  const ui = await $.ui.mount({ plugin: 'desktop-statusline', surface: 'desktop', component: 'AbovePrompt', props })
  return JSON.stringify(await ui.drawn())
}

test('display: bar draws the bar without the percentage', { options: { display: 'bar' } }, async ($, on) => {
  const tree = await drawn($, on)
  expect(tree).toMatch('"width":3,"height":1,"backgroundColor":"success"')
  expect(tree).not.toMatch('["34%"]')
})

test('display: percent draws the percentage without the bar', { options: { display: 'percent' } }, async ($, on) => {
  const tree = await drawn($, on)
  expect(tree).toMatch('["34%"]')
  expect(tree).not.toMatch('"width":3,"height":1,"backgroundColor":"success"')
})

test('items picks and orders what is drawn', { options: { items: 'cost | context', barWidth: 6 } }, async ($, on) => {
  const tree = await drawn($, on)
  expect(tree).not.toMatch('34%')
  expect(tree.indexOf('$1.50')).toBeLessThan(tree.indexOf('["42%"]'))
  expect(tree).toMatch('"width":6')
  // 42 % of 6 cells.
  expect(tree).toMatch('"width":3,"height":1,"backgroundColor":"success"')
})
