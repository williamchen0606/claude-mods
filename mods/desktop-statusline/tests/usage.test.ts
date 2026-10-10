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
  recordSample,
  runOut,
  segmentText,
  snapshotOf,
  statusLines,
} from '../hooks/usage'
import type { Line } from '../hooks/usage'
import {
  DEFAULT_LAYOUT,
  MAX_LINES,
  addItem,
  addLine,
  moveItem,
  moveItemToLine,
  moveLine,
  normalizeLayout,
  removeItem,
  removeLine,
  unusedItems,
} from '../hooks/layout'

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

const lineOf = (lines: ReturnType<typeof statusLines>) =>
  lines.map(line => line.map((s, i) => (i === 0 ? '' : s.joined ? ' · ' : ' │ ') + segmentText(s)).join(''))

test('statusLines reads as one line by default, joining items of one family', () => {
  expect(lineOf(statusLines(sample, 7 * HOUR, DEFAULT_LAYOUT))).toEqual([
    '5h 75% · 3h00m 後重置 · 約 50m 後用完 │ 7d 12% · 3d4h 後重置 │ Context 42% / 200k │ $1.23',
  ])
})

test('statusLines draws several lines, and drops empty items and lines', () => {
  const layout = [['context', 'cost'], [], ['7d-reset', '5h']] as const
  expect(lineOf(statusLines(sample, 7 * HOUR, layout.map(l => [...l])))).toEqual([
    'Context 42% / 200k │ $1.23',
    '3d4h 後重置 │ 5h 75%',
  ])
  expect(lineOf(statusLines({ costUsd: 0.5 }, 0, [['5h', '5h-reset'], ['cost']]))).toEqual(['$0.50'])
})

test('percentages carry a bar colored by how much is used', () => {
  const [line] = statusLines(sample, 7 * HOUR, DEFAULT_LAYOUT)
  expect(line?.[0]).toMatchObject({ bar: 75, barColor: 'warning', color: 'warning' })
  expect(line?.[3]).toMatchObject({ bar: 12, barColor: 'success' })
})

test('remaining percentages drain the bar but keep the used level\'s color', () => {
  const lines = statusLines(sample, 7 * HOUR, [['5h'], ['context']], 'remaining')
  expect(lineOf(lines)).toEqual(['5h 剩 25%', 'Context 剩 58% / 200k'])
  expect(lines[0]?.[0]).toMatchObject({ bar: 25, barColor: 'warning' })
})

test('filledCells keeps a little and nearly all visible', () => {
  expect(filledCells(0, 10)).toBe(0)
  expect(filledCells(4, 10)).toBe(1)
  expect(filledCells(34, 10)).toBe(3)
  expect(filledCells(98, 10)).toBe(9)
  expect(filledCells(100, 10)).toBe(10)
})

describe('the layout', () => {
  test('normalizeLayout drops unknown and repeated ids, and caps the lines', () => {
    expect(normalizeLayout([['5h', 'nope', '5h'], ['cost', '5h'], 'junk'])).toEqual([['5h'], ['cost'], []])
    expect(normalizeLayout(undefined)).toEqual(DEFAULT_LAYOUT.map(l => [...l]))
    expect(normalizeLayout([])).toEqual(DEFAULT_LAYOUT.map(l => [...l]))
    expect(normalizeLayout(Array.from({ length: 9 }, () => []))).toHaveLength(MAX_LINES)
  })

  test('only unused items can be added, so none repeats', () => {
    const layout: Line[] = [['5h', 'cost'], []]
    expect(unusedItems(layout)).toEqual(['5h-reset', '5h-estimate', '7d', '7d-reset', 'context'])
    expect(addItem(layout, 1, 'cost')).toEqual(layout)
    expect(addItem(layout, 1, 'context')).toEqual([['5h', 'cost'], ['context']])
    expect(addItem(layout, 5, 'context')).toEqual(layout)
  })

  test('items move within and between lines, and come off', () => {
    const layout: Line[] = [['5h', '5h-reset', 'cost'], ['context']]
    expect(moveItem(layout, 0, 'cost', -1)).toEqual([['5h', 'cost', '5h-reset'], ['context']])
    expect(moveItem(layout, 0, '5h', -1)).toEqual(layout)
    expect(moveItemToLine(layout, 0, 'cost', 1)).toEqual([['5h', '5h-reset'], ['context', 'cost']])
    expect(moveItemToLine(layout, 0, 'cost', -1)).toEqual(layout)
    expect(removeItem(layout, 0, '5h-reset')).toEqual([['5h', 'cost'], ['context']])
  })

  test('lines are added up to the cap, moved and removed', () => {
    let layout: Line[] = [['5h'], ['cost']]
    expect(moveLine(layout, 1, -1)).toEqual([['cost'], ['5h']])
    expect(removeLine(layout, 0)).toEqual([['cost']])
    expect(removeLine([['cost']] as Line[], 0)).toEqual([[]])
    for (let i = 0; i < 10; i++) layout = addLine(layout)
    expect(layout).toHaveLength(MAX_LINES)
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

test('barWidth sizes the bars', { options: { barWidth: 6 } }, async ($, on) => {
  const tree = await drawn($, on)
  expect(tree).toMatch('"width":6')
  // 34 % of 6 cells.
  expect(tree).toMatch('"width":2,"height":1,"backgroundColor":"success"')
})

test('the editor picks items from a list and lays them out on several lines', async ($, on) => {
  const band = await drawn($, on)
  expect(band).toMatch('$1.50')

  const pane = await $.ui.mount({
    plugin: 'desktop-statusline',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'desktop-statusline',
    props: { title: '狀態列設定', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  // Everything is on line 1 by default, so nothing is offered to add.
  await pane.press({ key: 'edit-0' })
  expect(await pane.find({ key: 'add-cost' })).toBeUndefined()
  await pane.press({ key: 'remove-cost' })
  await pane.press({ key: 'remove-context' })
  await pane.press({ key: 'back' })

  await pane.press({ key: 'add-line' })
  await pane.press({ key: 'edit-1' })
  await pane.press({ key: 'add-cost' })
  await pane.press({ key: 'add-context' })
  // Already placed: no longer offered.
  expect(await pane.find({ key: 'add-cost' })).toBeUndefined()
  await pane.press({ key: 'left-context' })

  const after = await (
    await $.ui.mount({ plugin: 'desktop-statusline', surface: 'desktop', component: 'AbovePrompt', props })
  ).drawn()
  const rows = (after as unknown as { children: { props: { key?: string } }[] }).children
  const lines = rows.filter(row => row.props.key?.startsWith('line-')).map(row => JSON.stringify(row))
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatch('後重置')
  expect(lines[0]).not.toMatch('$1.50')
  // Context moved before cost on line 2.
  expect(lines[1]?.indexOf('Context')).toBeLessThan(lines[1]?.indexOf('$1.50') ?? -1)
})
