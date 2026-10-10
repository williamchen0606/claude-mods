// The status line's layout and the editor's moves on it: pure, so the tests import them directly.

import { ITEMS } from './usage'
import type { ItemId, Line } from './usage'

/** Every item id, in the order the editor offers them. */
export const ITEM_IDS = Object.keys(ITEMS) as ItemId[]

/** What the editor calls each item, and what it shows. */
export const ITEM_INFO: Record<ItemId, { name: string; sample: string }> = {
  '5h': { name: '5 小時用量', sample: '5h ███░░░ 34%' },
  '5h-reset': { name: '5 小時重置倒數', sample: '2h10m 後重置' },
  '5h-estimate': { name: '5 小時還能撐多久', sample: '約 1h20m 後用完 / 可撐到重置' },
  '7d': { name: '7 天用量', sample: '7d █░░░░░ 12%' },
  '7d-reset': { name: '7 天重置倒數', sample: '3d4h 後重置' },
  context: { name: 'Context 使用率', sample: 'Context ████░░ 42% / 200k' },
  cost: { name: '花費', sample: '$1.23' },
}

/** The most lines the status line takes. */
export const MAX_LINES = 4

/** Everything on one line, in the editor's order. */
export const DEFAULT_LAYOUT: readonly Line[] = [ITEM_IDS]

function isItemId(id: unknown): id is ItemId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ITEMS, id)
}

/**
 * A stored layout made safe to draw: unknown ids and repeats dropped, at most
 * MAX_LINES lines. Anything that is not a list of lists is the default.
 */
export function normalizeLayout(value: unknown): Line[] {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_LAYOUT.map(line => [...line])
  const seen = new Set<ItemId>()
  return value.slice(0, MAX_LINES).map(line =>
    (Array.isArray(line) ? line : []).filter((id): id is ItemId => {
      if (!isItemId(id) || seen.has(id)) return false
      seen.add(id)
      return true
    }),
  )
}

/** The items no line shows yet: the only ones the editor offers to add. */
export function unusedItems(layout: readonly Line[]): ItemId[] {
  const used = new Set(layout.flat())
  return ITEM_IDS.filter(id => !used.has(id))
}

const withLine = (layout: readonly Line[], index: number, fn: (line: Line) => Line): Line[] =>
  layout.map((line, i) => (i === index ? fn([...line]) : [...line]))

/** Adds an item at the end of a line, unless some line already shows it. */
export function addItem(layout: readonly Line[], index: number, id: ItemId): Line[] {
  if (layout.some(line => line.includes(id)) || !layout[index]) return layout.map(line => [...line])
  return withLine(layout, index, line => [...line, id])
}

export function removeItem(layout: readonly Line[], index: number, id: ItemId): Line[] {
  return withLine(layout, index, line => line.filter(other => other !== id))
}

/** Moves an item one place left (-1) or right (+1) within its line. */
export function moveItem(layout: readonly Line[], index: number, id: ItemId, by: -1 | 1): Line[] {
  return withLine(layout, index, line => {
    const from = line.indexOf(id)
    const to = from + by
    if (from < 0 || to < 0 || to >= line.length) return line
    ;[line[from], line[to]] = [line[to]!, line[from]!]
    return line
  })
}

/** Moves an item to the end of the line above (-1) or below (+1). */
export function moveItemToLine(layout: readonly Line[], index: number, id: ItemId, by: -1 | 1): Line[] {
  const target = index + by
  if (!layout[index]?.includes(id) || !layout[target]) return layout.map(line => [...line])
  return layout.map((line, i) =>
    i === index ? line.filter(other => other !== id) : i === target ? [...line, id] : [...line],
  )
}

export function addLine(layout: readonly Line[]): Line[] {
  const copy = layout.map(line => [...line])
  return copy.length >= MAX_LINES ? copy : [...copy, []]
}

/** Removes a line and the items on it; the last line stays, emptied. */
export function removeLine(layout: readonly Line[], index: number): Line[] {
  if (layout.length <= 1) return [[]]
  return layout.filter((_, i) => i !== index).map(line => [...line])
}

/** Swaps a line with the one above (-1) or below (+1). */
export function moveLine(layout: readonly Line[], index: number, by: -1 | 1): Line[] {
  const copy = layout.map(line => [...line])
  const to = index + by
  if (!copy[index] || !copy[to]) return copy
  ;[copy[index], copy[to]] = [copy[to]!, copy[index]!]
  return copy
}
