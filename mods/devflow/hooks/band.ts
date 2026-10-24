import type { Progress, Stage, StageStatus } from '../types'

/** Where the skills keep progress, relative to the project root. */
export const PROGRESS_FILE = '.devflow/state.json'

const STATUSES: readonly StageStatus[] = ['pending', 'active', 'done', 'skipped']

const MARKS: Record<StageStatus, string> = { pending: '○', active: '●', done: '✓', skipped: '⊘' }

function words(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text === '' ? undefined : text.slice(0, max)
}

function stageOf(value: unknown): Stage | null {
  if (typeof value !== 'object' || value === null) return null
  const { name, status, note } = value as Record<string, unknown>
  const stageName = words(name, 24)
  if (!stageName || !STATUSES.includes(status as StageStatus)) return null
  const stage: Stage = { name: stageName, status: status as StageStatus }
  const stageNote = words(note, 40)
  if (stageNote) stage.note = stageNote
  return stage
}

/**
 * Parses the progress file's text. Anything that is not the expected shape
 * is null: a half-written file, an older format, or a hand edit should blank
 * the band rather than throw inside a render.
 */
export function parseProgress(text: string): Progress | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const { track, size, task, stages, spec, updatedAt } = data as Record<string, unknown>
  const trackName = words(track, 16)
  const sizeName = words(size, 4)
  if (!trackName || !sizeName || !Array.isArray(stages)) return null
  const parsed = stages.map(stageOf).filter((s): s is Stage => s !== null)
  if (parsed.length === 0) return null
  const progress: Progress = { track: trackName, size: sizeName, stages: parsed }
  const taskName = words(task, 80)
  if (taskName) progress.task = taskName
  const specPath = words(spec, 200)
  if (specPath) progress.spec = specPath
  const at = words(updatedAt, 40)
  if (at) progress.updatedAt = at
  return progress
}

/** One piece of the band: its text, and whether it is drawn dim (pending, skipped) or bright (active). */
export type Segment = { text: string; tone: 'dim' | 'plain' | 'bright' }

/** The stage that is being worked on, or the last done one when none is active. */
export function currentStage(progress: Progress): Stage | undefined {
  return progress.stages.find(s => s.status === 'active') ?? [...progress.stages].reverse().find(s => s.status === 'done')
}

/** Whether every stage is done or skipped. */
export function isFinished(progress: Progress): boolean {
  return progress.stages.every(s => s.status === 'done' || s.status === 'skipped')
}

/**
 * The band's first row: `devflow · bug · S · diagnose ✓ › tdd ● › prove ○ › ship ○`.
 * Each stage is its own segment so the active one can be drawn bright.
 */
export function stageSegments(progress: Progress): Segment[] {
  const head: Segment = { text: `devflow · ${progress.track} · ${progress.size}`, tone: 'plain' }
  const stages = progress.stages.flatMap((stage, i): Segment[] => {
    const tone: Segment['tone'] = stage.status === 'active' ? 'bright' : stage.status === 'done' ? 'plain' : 'dim'
    const sep: Segment[] = i === 0 ? [{ text: ' · ', tone: 'dim' }] : [{ text: ' › ', tone: 'dim' }]
    return [...sep, { text: `${stage.name} ${MARKS[stage.status]}`, tone }]
  })
  return [head, ...stages]
}

/** The band's second row: what is happening now, or nothing when there is nothing to add. */
export function detailText(progress: Progress): string | undefined {
  const stage = currentStage(progress)
  const parts: string[] = []
  if (isFinished(progress)) parts.push('完成')
  else if (stage?.status === 'active') parts.push(stage.note ? `${stage.name}：${stage.note}` : '')
  if (progress.task) parts.push(progress.task)
  const skipped = progress.stages.filter(s => s.status === 'skipped')
  for (const s of skipped) parts.push(`${s.name} 跳過${s.note ? `：${s.note}` : ''}`)
  const text = parts.filter(p => p !== '').join(' · ')
  return text === '' ? undefined : text
}

/** The band as one line of plain text, for the status line and for narrow columns. */
export function plainText(progress: Progress): string {
  return stageSegments(progress)
    .map(s => s.text)
    .join('')
}

/** Cuts a line to `columns` cells with an ellipsis, counting wide characters as two. */
export function fit(text: string, columns: number): string {
  if (columns <= 1) return ''
  let width = 0
  let cut = text.length
  for (let i = 0; i < text.length; i++) {
    const w = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(text[i] ?? '') ? 2 : 1
    if (width + w > columns - 1) {
      cut = i
      break
    }
    width += w
  }
  return cut >= text.length ? text : `${text.slice(0, cut)}…`
}
