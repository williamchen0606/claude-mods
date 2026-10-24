import { describe, expect, test } from 'claude-code/testing'

import { currentStage, detailText, fit, isFinished, parseProgress, plainText, stageSegments } from '../hooks/band'

const file = JSON.stringify({
  track: 'bug',
  size: 'S',
  task: 'slugify strips edge hyphens',
  stages: [
    { name: 'diagnose', status: 'done' },
    { name: 'tdd', status: 'active', note: 'slice 1/1' },
    { name: 'prove', status: 'pending' },
    { name: 'ship', status: 'skipped', note: 'user commits' },
  ],
  spec: 'docs/specs/2026-10-24-slugify.md',
})

describe('parseProgress', () => {
  test('reads the file the skills write', () => {
    const progress = parseProgress(file)
    expect(progress?.track).toBe('bug')
    expect(progress?.stages.length).toBe(4)
    expect(progress?.stages[1]).toEqual({ name: 'tdd', status: 'active', note: 'slice 1/1' })
    expect(progress?.spec).toBe('docs/specs/2026-10-24-slugify.md')
  })

  test('is null for a half-written or foreign file', () => {
    expect(parseProgress('{"track": "bug", "si')).toBe(null)
    expect(parseProgress('[]')).toBe(null)
    expect(parseProgress('{"track":"bug","size":"S","stages":[]}')).toBe(null)
    expect(parseProgress('{"track":"bug","size":"S","stages":[{"name":"x","status":"nope"}]}')).toBe(null)
  })

  test('drops a malformed stage and keeps the rest', () => {
    const progress = parseProgress('{"track":"feature","size":"M","stages":[{"name":"spec","status":"done"},{"status":"active"}]}')
    expect(progress?.stages.map(s => s.name)).toEqual(['spec'])
  })

  test('bounds what it keeps', () => {
    const progress = parseProgress(JSON.stringify({ track: 'x'.repeat(50), size: 'S', task: 'y'.repeat(200), stages: [{ name: 'a', status: 'pending' }] }))
    expect(progress?.track.length).toBe(16)
    expect(progress?.task?.length).toBe(80)
  })
})

describe('the band', () => {
  const progress = parseProgress(file)!

  test('names the route and marks each stage', () => {
    expect(plainText(progress)).toBe('devflow · bug · S · diagnose ✓ › tdd ● › prove ○ › ship ⊘')
    const tones = stageSegments(progress).map(s => s.tone)
    expect(tones).toEqual(['plain', 'dim', 'plain', 'dim', 'bright', 'dim', 'dim', 'dim', 'dim'])
  })

  test('says what is happening now and what was skipped', () => {
    expect(currentStage(progress)?.name).toBe('tdd')
    expect(detailText(progress)).toBe('tdd：slice 1/1 · slugify strips edge hyphens · ship 跳過：user commits')
    expect(isFinished(progress)).toBe(false)
  })

  test('says done once every stage is done or skipped', () => {
    const done = { ...progress, stages: progress.stages.map(s => (s.status === 'done' || s.status === 'skipped' ? s : { ...s, status: 'done' as const })) }
    expect(isFinished(done)).toBe(true)
    expect(detailText(done)).toBe('完成 · slugify strips edge hyphens · ship 跳過：user commits')
    expect(currentStage(done)?.name).toBe('prove')
  })

  test('has no detail row when there is nothing to add', () => {
    expect(detailText({ track: 'chore', size: 'S', stages: [{ name: 'do', status: 'active' }] })).toBe(undefined)
  })
})

describe('fit', () => {
  test('keeps a line that fits and cuts one that does not', () => {
    expect(fit('abc', 10)).toBe('abc')
    expect(fit('abcdefghij', 6)).toBe('abcde…')
    expect(fit('完成完成完成', 6)).toBe('完成…')
    expect(fit('abc', 1)).toBe('')
  })
})
