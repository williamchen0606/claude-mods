import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, SessionUsage } from 'claude-code'

import type { UsageSnapshot } from '../types'
import {
  DEFAULT_LAYOUT,
  ITEM_INFO,
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
} from './layout'
import { filledCells, fillRate, recordSample, snapshotOf, statusLines } from './usage'
import type { DisplayMode, ItemId, Line, LineSegment, PercentMode, SampleLog } from './usage'

const usageAtom = atom({ plugin: 'desktop-statusline', key: 'usage' } as const, null as UsageSnapshot | null)
const nowAtom = atom({ plugin: 'desktop-statusline', key: 'now' } as const, 0)
const layoutAtom = atom({ plugin: 'desktop-statusline', key: 'layout' } as const, null as string[][] | null)
const editingAtom = atom({ plugin: 'desktop-statusline', key: 'editing' } as const, null as number | null)

/** How often the countdowns are redrawn and the figures re-read, in ms. */
const TICK_MS = 30_000

/** The `$.store` key of the 5-hour window's samples; the window is the account's, so they outlive a session. */
const SAMPLES_KEY = 'five-hour-samples'

/** The `$.store` key of the layout the editor saves, shared by every session. */
const LAYOUT_KEY = 'layout'

/** The editor's pane, and the command that opens it. */
const EDITOR = 'desktop-statusline'

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

/** Applies an editor move to the layout, and saves it for every session. */
async function edit($: EngineInterface, move: (layout: Line[]) => Line[]) {
  let saved: Line[] = []
  await update($, layoutAtom, stored => (saved = move(normalizeLayout(stored))))
  await $.store.set(LAYOUT_KEY, saved)
}

async function openEditor($: EngineInterface) {
  await update($, editingAtom, () => null)
  return $.ui.open({ id: EDITOR, title: '狀態列設定', focus: true, closeOnEscape: true })
}

export const register: Register = (on, options) => {
  const showInTerminal = options.showInTerminal === true
  const percent: PercentMode = options.percent === 'remaining' ? 'remaining' : 'used'
  const display: DisplayMode = options.display === 'bar' || options.display === 'percent' ? options.display : 'both'
  const barWidth =
    typeof options.barWidth === 'number' && Number.isFinite(options.barWidth)
      ? Math.min(40, Math.max(3, Math.round(options.barWidth)))
      : 10

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: EDITOR, description: '設定狀態列要顯示哪些欄位、順序和行數' })
    const stored = await $.store.get(LAYOUT_KEY).catch(() => undefined)
    await update($, layoutAtom, () => normalizeLayout(stored))
    await refresh($).catch(() => {})
    $.clock.every(TICK_MS, () => {
      refresh($).catch(() => {})
    })
    return result
  })

  on('command.run', { command: EDITOR }, async $ => {
    const opened = await openEditor($)
    return { text: opened.isPlaced ? '已開啟狀態列設定。' : '狀態列設定已開啟，終端機寬度不夠時會等加寬後才顯示。' }
  }).catch(() => ({ text: '無法開啟狀態列設定。' }))

  // Pushed after each turn, and when a rate-limit window moves a whole point.
  on('session.measure', async ($, e, next) => {
    await refresh($, e).catch(() => {})
    return next(e)
  })

  /** Draws the status line's lines with the surface's elements. */
  function drawLines(
    { Box, Text }: Pick<Elements['desktop'], 'Box' | 'Text'>,
    lines: LineSegment[][],
    trailing?: JSX.Element,
  ) {
    return lines.map((line, l) => (
      <Box key={`line-${l}`} flexDirection="row" flexWrap="wrap" columnGap={1}>
        {line.flatMap((segment, s) => [
          ...(s > 0 ? [<Text key={`sep-${l}-${s}`} dimColor>{segment.joined ? '·' : '│'}</Text>] : []),
          <Box key={`seg-${l}-${s}`} flexDirection="row" alignItems="center" columnGap={1}>
            {segment.label ? <Text dimColor>{segment.label}</Text> : null}
            {segment.bar !== undefined && display !== 'percent' ? (
              <Box width={barWidth} height={1} backgroundColor="subtle">
                <Box width={filledCells(segment.bar, barWidth)} height={1} backgroundColor={segment.barColor ?? 'success'} />
              </Box>
            ) : null}
            {segment.percent !== undefined && display !== 'bar' ? <Text color={segment.color}>{segment.percent}</Text> : null}
            {segment.text !== undefined ? (
              <Text
                color={segment.percent === undefined ? segment.color : undefined}
                dimColor={!segment.color || segment.percent !== undefined}
              >
                {segment.text}
              </Text>
            ) : null}
          </Box>,
        ])}
        {l === lines.length - 1 ? trailing : null}
      </Box>
    ))
  }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || (e.surface === 'terminal' && !showInTerminal)) return below

    const usage = await read($, usageAtom)
    const layout = normalizeLayout((await read($, layoutAtom)) ?? DEFAULT_LAYOUT)
    const lines = usage ? statusLines(usage, (await read($, nowAtom)) || Date.now(), layout, percent) : []
    if (lines.length === 0) return below

    const { Box, Button } = $.ui.resolve(e)
    const settings = <Button key="settings" label="⚙" plain dimColor onPress={() => void openEditor($)} />
    return (
      <Box flexDirection="column">
        {below}
        {drawLines($.ui.resolve(e), lines, settings)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: EDITOR }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const layout = normalizeLayout((await read($, layoutAtom)) ?? DEFAULT_LAYOUT)
    const editing = await read($, editingAtom)
    const usage = await read($, usageAtom)
    const preview = usage ? statusLines(usage, (await read($, nowAtom)) || Date.now(), layout, percent) : []

    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>預覽</Text>
        {preview.length > 0 ? drawLines($.ui.resolve(e), preview) : <Text dimColor>（還沒有資料，或沒有要顯示的欄位）</Text>}
      </Box>
    )

    const line = editing === null ? undefined : layout[editing]
    if (editing === null || !line) {
      return (
        <Box flexDirection="column">
          {header}
          <Text bold>行</Text>
          {layout.map((items, l) => (
            <Box key={`row-${l}`} flexDirection="column">
              <Box flexDirection="row" columnGap={1} alignItems="center">
                <Button key={`edit-${l}`} label={`編輯第 ${l + 1} 行`} onPress={() => update($, editingAtom, () => l)} />
                {l > 0 ? <Button key={`up-${l}`} label="↑" plain dimColor onPress={() => edit($, x => moveLine(x, l, -1))} /> : null}
                {l < layout.length - 1 ? (
                  <Button key={`down-${l}`} label="↓" plain dimColor onPress={() => edit($, x => moveLine(x, l, 1))} />
                ) : null}
                <Button key={`drop-${l}`} label="刪除" plain dimColor onPress={() => edit($, x => removeLine(x, l))} />
              </Box>
              <Box paddingLeft={2}>
                <Text dimColor>{items.length > 0 ? items.map(id => ITEM_INFO[id].name).join('、') : '（空）'}</Text>
              </Box>
            </Box>
          ))}
          <Box flexDirection="row" columnGap={1} marginTop={1}>
            {layout.length < MAX_LINES ? <Button key="add-line" label="+ 新增一行" onPress={() => edit($, addLine)} /> : null}
            <Button key="reset" label="恢復預設" onPress={() => edit($, () => DEFAULT_LAYOUT.map(l => [...l]))} />
            <Button key="close" label="完成" variant="primary" role="dismiss" onPress={() => $.ui.close({ id: EDITOR })} />
          </Box>
          <Text dimColor>選一行來編輯它的欄位。進度條、百分比和寬度在 /config 設定。</Text>
        </Box>
      )
    }

    const l = editing
    const unused = unusedItems(layout)
    const itemRow = (id: ItemId, i: number) => (
      <Box key={`item-${id}`} flexDirection="row" columnGap={1} alignItems="center">
        <Text>{`${i + 1}. ${ITEM_INFO[id].name}`}</Text>
        {i > 0 ? <Button key={`left-${id}`} label="↑ 往前" plain dimColor onPress={() => edit($, x => moveItem(x, l, id, -1))} /> : null}
        {i < line.length - 1 ? (
          <Button key={`right-${id}`} label="↓ 往後" plain dimColor onPress={() => edit($, x => moveItem(x, l, id, 1))} />
        ) : null}
        {l > 0 ? <Button key={`lineup-${id}`} label="移到上一行" plain dimColor onPress={() => edit($, x => moveItemToLine(x, l, id, -1))} /> : null}
        {l < layout.length - 1 ? (
          <Button key={`linedown-${id}`} label="移到下一行" plain dimColor onPress={() => edit($, x => moveItemToLine(x, l, id, 1))} />
        ) : null}
        <Button key={`remove-${id}`} label="移除" plain dimColor onPress={() => edit($, x => removeItem(x, l, id))} />
      </Box>
    )
    return (
      <Box flexDirection="column">
        {header}
        <Text bold>{`第 ${l + 1} 行的欄位（由左到右）`}</Text>
        {line.length > 0 ? line.map(itemRow) : <Text dimColor>（這一行還沒有欄位）</Text>}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>新增欄位</Text>
          {unused.length > 0 ? (
            unused.map(id => (
              <Button key={`add-${id}`} plain onPress={() => edit($, x => addItem(x, l, id))}>
                {`+ ${ITEM_INFO[id].name}`} <Text dimColor>{ITEM_INFO[id].sample}</Text>
              </Button>
            ))
          ) : (
            <Text dimColor>所有欄位都已經在狀態列上了。</Text>
          )}
        </Box>
        <Box flexDirection="row" columnGap={1} marginTop={1}>
          <Button key="back" label="← 返回" variant="primary" onPress={() => update($, editingAtom, () => null)} />
        </Box>
      </Box>
    )
  })
}
