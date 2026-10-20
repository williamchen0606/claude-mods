import { describe, expect, test } from 'claude-code/testing'

import { clairicBody, commandsAfter, parseClairic, stateTextOf } from '../hooks/clairic'
import { findingsOf } from '../hooks/verify'
import type { Turn } from '../hooks/verify'

/** Expects `actual` to be `expected`, give or take rounding. */
function near(actual: number | undefined, expected: number): void {
  expect(Math.abs((actual ?? Number.NaN) - expected) < 1e-9).toBe(true)
}

const turn: Turn = {
  request: 'fix the parser, API_TOKEN=s3cr3t',
  steps: [
    { kind: 'command', command: 'npm test', failed: true, output: 'old failure' },
    { kind: 'change', path: '/home/me/proj/src/parser.ts' },
    { kind: 'command', command: 'npm test', failed: true, output: `${'x'.repeat(3_000)}Tests: 3 failed, 120 passed` },
    { kind: 'command', command: 'git status', failed: false, output: 'clean' },
  ],
}

/** A Workers AI response carrying Clairic's answers: every list empty and sure, unless a test says otherwise. */
function says(answers: Record<string, unknown> = {}, enveloped = true): string {
  const empty = { type: 'list', value: [], spans: [], confidence: 0.98 }
  const all = {
    code_changes: { type: 'list', value: ['./src/parser.ts'], spans: [[0, 1]], confidence: 0.95 },
    check_commands: { type: 'list', value: ['npm test'], spans: [[0, 1]], confidence: 0.96 },
    passed_counts: { type: 'list', value: [120], confidence: 0.97 },
    failed_counts: { type: 'list', value: [0], confidence: 0.97 },
    failures: empty,
    unsupported_claims: empty,
    undone_parts: empty,
    question: { type: 'text', value: null, guess: 'Done?', p_null: 0.99, confidence: 0.9 },
    ...answers,
  }
  return JSON.stringify(enveloped ? { success: true, result: { model: 'clairic', answers: all, truncated: false } } : { answers: all })
}

/** The same turn with its checks passing: the test run after the change exits cleanly. */
const passing: Turn = { ...turn, steps: turn.steps.map((step, i) => (i === 2 && step.kind === 'command' ? { ...step, failed: false } : step)) }

describe('the Clairic request', () => {
  test('splits the steps at the last change and keeps the output after it', () => {
    expect(commandsAfter(turn).map(step => step.command)).toEqual(['npm test', 'git status'])

    const state = stateTextOf(turn, 'Fixed, tests pass.', { root: '/home/me/proj', home: '/home/me' })
    expect(state.startsWith('REQUEST:\nfix the parser, API_TOKEN=<redacted>\n\nSTEPS UP TO THE LAST CHANGED FILE:\n[1] ran: npm test (failed)\n[2] changed: ./src/parser.ts\n\n')).toBe(true)
    expect(state).not.toContain('old failure')
    expect(state).toContain('COMMANDS RUN AFTER THE LAST CHANGED FILE:\n[3] ran: npm test (failed)\noutput (end):\n…')
    expect(state).toContain('Tests: 3 failed, 120 passed\n\n[4] ran: git status\noutput (end):\nclean')
    expect(state.endsWith('FINAL MESSAGE:\nFixed, tests pass.')).toBe(true)
    // Up to 2,000 characters of output per command after the change.
    expect(state.length).toBeLessThan(2_600)
    expect(state.length).toBeGreaterThan(2_000)
  })

  test('shrinks the output to fit one pass', () => {
    const many: Turn = {
      request: 'r',
      steps: [{ kind: 'change', path: '/p/a.ts' }, ...Array.from({ length: 20 }, (_, i) => ({ kind: 'command' as const, command: `cmd ${i}`, failed: false, output: 'y'.repeat(5_000) }))],
    }
    const state = stateTextOf(many, '', {})
    expect(state.length).toBeLessThanOrEqual(16_000)
    expect(state).toContain('[21] ran: cmd 19')
  })

  test('marks a turn with no command after the change', () => {
    const state = stateTextOf({ request: 'r', steps: [{ kind: 'change', path: '/p/a.ts' }] }, 'done', {})
    expect(state).toContain('COMMANDS RUN AFTER THE LAST CHANGED FILE:\n(none)')
  })

  test('asks for the facts as typed fields', () => {
    const body = JSON.parse(clairicBody(turn, 'done', {}))
    expect(body.model).toBe('clairic')
    expect(typeof body.state).toBe('string')
    expect(Object.keys(body.fields)).toEqual(['code_changes', 'check_commands', 'passed_counts', 'failed_counts', 'failures', 'unsupported_claims', 'undone_parts', 'question'])
    expect(body.fields.failed_counts).toEqual(expect.objectContaining({ type: 'list', items: 'number' }))
    expect(body.fields.question.type).toBe('text')
  })
})

describe('parseClairic', () => {
  test('a checked, passing turn', () => {
    const verdict = parseClairic(says({}, false), passing)!
    expect(verdict.needsCheck).toBe(0.95)
    expect(verdict.checked).toBe(0.96)
    near(verdict.passed, 0.97)
    expect(verdict.claimsOk).toBe(0.98)
    near(verdict.unfinished, 0.02)
    near(verdict.asksUser, 0.01)
    expect(verdict.tests).toEqual({ passed: 120, failed: 0 })
    expect(verdict.evidence).toBeUndefined()
    expect(findingsOf(verdict, 0.7)).toEqual([])
  })

  test('failed counts and failures make the checks fail, with the evidence', () => {
    const verdict = parseClairic(
      says({ failed_counts: { type: 'list', value: [3], confidence: 0.9 }, failures: { type: 'list', value: ['parser > empty input'], confidence: 0.85 } }),
      passing,
    )!
    near(verdict.passed, 0.1)
    expect(verdict.tests).toEqual({ passed: 120, failed: 3 })
    expect(verdict.evidence?.failing).toEqual(['失敗 3 個', 'parser > empty input'])
    expect(findingsOf(verdict, 0.7)).toEqual(['failing'])
  })

  test('a check that exited with an error failed, whatever its output says', () => {
    const verdict = parseClairic(says(), turn)!
    expect(verdict.passed).toBe(0)
    expect(verdict.evidence?.failing).toEqual(['npm test（結束時回報錯誤）'])
  })

  test('a command that is no check failing does not count', () => {
    const grep: Turn = { request: 'r', steps: [{ kind: 'change', path: '/p/a.ts' }, { kind: 'command', command: 'grep -r TODO src', failed: true, output: '' }, { kind: 'command', command: 'npm test', failed: false, output: 'ok' }] }
    near(parseClairic(says(), grep)!.passed, 0.97)
  })

  test('no command after the last change means not checked', () => {
    const verdict = parseClairic(says(), { request: 'r', steps: [{ kind: 'command', command: 'npm test', failed: false, output: 'ok' }, { kind: 'change', path: '/p/a.ts' }] })!
    expect(verdict.checked).toBe(0)
    expect(findingsOf(verdict, 0.7)).toEqual(['unchecked'])
  })

  test('docs-only changes need no check', () => {
    const verdict = parseClairic(says({ code_changes: { type: 'list', value: [], confidence: 0.9 } }), { request: 'r', steps: [{ kind: 'change', path: '/p/README.md' }] })!
    near(verdict.needsCheck, 0.1)
    expect(findingsOf(verdict, 0.7)).toEqual([])
  })

  test('unsupported claims and undone parts, quoted', () => {
    const verdict = parseClairic(
      says({
        unsupported_claims: { type: 'list', value: ['All tests pass.'], spans: [[0, 15]], confidence: 0.9 },
        undone_parts: { type: 'list', value: ['update the docs'], spans: [[0, 15]], confidence: 0.8 },
      }),
      passing,
    )!
    near(verdict.claimsOk, 0.1)
    expect(verdict.unfinished).toBe(0.8)
    expect(verdict.evidence).toEqual({ unsupported: ['All tests pass.'], unfinished: ['update the docs'] })
    expect(findingsOf(verdict, 0.7)).toEqual(['unsupported', 'unfinished'])
  })

  test('nothing is missing while Claude asks the person', () => {
    const verdict = parseClairic(says({ question: { type: 'text', value: 'Should I also update the CLI?', span: [0, 1], p_null: 0.05, confidence: 0.9 } }), turn)!
    near(verdict.asksUser, 0.95)
    expect(findingsOf(verdict, 0.7)).toEqual([])
  })

  test('rejects what is not an answer', () => {
    expect(parseClairic('nope', turn)).toBeUndefined()
    expect(parseClairic(JSON.stringify({ result: { answers: 'x' } }), turn)).toBeUndefined()
    expect(parseClairic(JSON.stringify({ answers: { code_changes: { value: 'x' } } }), { request: 'r', steps: [{ kind: 'change', path: '/p/a.ts' }, { kind: 'command', command: 'ls', failed: false, output: '' }] })).toBeUndefined()
  })
})
