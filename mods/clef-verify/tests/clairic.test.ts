import { describe, expect, test } from 'claude-code/testing'

import { clairicBody, commandsAfter, evidenceOf, extractedOf, parseFacts, stateTextOf } from '../hooks/clairic'
import type { Turn } from '../hooks/verify'

const turn: Turn = {
  request: 'fix the parser',
  steps: [
    { kind: 'command', command: 'npm test', failed: true, output: 'old failure' },
    { kind: 'change', path: '/home/me/proj/src/parser.ts' },
    { kind: 'command', command: 'API_TOKEN=s3cr3t npm test', failed: true, output: `${'x'.repeat(3_000)}Tests: 3 failed, 120 passed` },
    { kind: 'command', command: 'git status', failed: false, output: '' },
  ],
}
const after = commandsAfter(turn)

/** A Workers AI response carrying Clairic's answers, sure of each unless a test says otherwise. */
function says(answers: Record<string, unknown> = {}, enveloped = true): string {
  const all = {
    check_commands: { type: 'list', value: ['API_TOKEN=s3cr3t npm test'], spans: [[0, 1]], confidence: 0.96 },
    passed_counts: { type: 'list', value: [120], confidence: 0.97 },
    failed_counts: { type: 'list', value: [3], confidence: 0.97 },
    failures: { type: 'list', value: ['parser > empty input'], spans: [[0, 1]], confidence: 0.9 },
    ...answers,
  }
  return JSON.stringify(enveloped ? { success: true, result: { model: 'clairic', answers: all, truncated: false } } : { answers: all })
}

describe('the Clairic request', () => {
  test('reads only the commands after the last change, with the end of their output', () => {
    expect(after.map(step => step.command)).toEqual(['API_TOKEN=s3cr3t npm test', 'git status'])

    const state = stateTextOf(after)
    expect(state.startsWith('$ API_TOKEN=<redacted> npm test  (exited with an error)\n…')).toBe(true)
    expect(state).not.toContain('old failure')
    expect(state.endsWith('Tests: 3 failed, 120 passed\n\n$ git status\n(no output)')).toBe(true)
    // Up to 2,000 characters of output per command.
    expect(state.length).toBeLessThan(2_200)
    expect(state.length).toBeGreaterThan(2_000)
  })

  test('shrinks the output to fit one pass', () => {
    const many: Turn = {
      request: 'r',
      steps: [{ kind: 'change', path: '/p/a.ts' }, ...Array.from({ length: 30 }, (_, i) => ({ kind: 'command' as const, command: `cmd ${i}`, failed: false, output: 'y'.repeat(5_000) }))],
    }
    const commands = commandsAfter(many)
    expect(commands.length).toBe(20)
    const state = stateTextOf(commands)
    expect(state.length).toBeLessThanOrEqual(16_000)
    expect(state.startsWith('$ cmd 10\n')).toBe(true)
  })

  test('nothing after the last change, nothing to read', () => {
    expect(commandsAfter({ request: 'r', steps: [{ kind: 'command', command: 'npm test', failed: false, output: '' }, { kind: 'change', path: '/p/a.ts' }] })).toEqual([])
  })

  test('asks only for facts in the output', () => {
    const body = JSON.parse(clairicBody(after))
    expect(body.model).toBe('clairic')
    expect(typeof body.state).toBe('string')
    expect(Object.keys(body.fields)).toEqual(['check_commands', 'passed_counts', 'failed_counts', 'failures'])
    expect(body.fields.failed_counts.type).toBe('list')
    expect(body.fields.failed_counts.items).toBe('number')
  })
})

describe('parseFacts', () => {
  test('sums the counts and finds the checks that exited with an error', () => {
    const facts = parseFacts(says({ passed_counts: { type: 'list', value: [100, 20], confidence: 0.9 } }, false), after)!
    expect(facts).toEqual({ checks: ['API_TOKEN=s3cr3t npm test'], passed: 120, failed: 3, failures: ['parser > empty input'], errored: ['API_TOKEN=<redacted> npm test'] })
    expect(extractedOf(facts)).toEqual({
      check_commands: ['API_TOKEN=s3cr3t npm test'],
      tests_passed: 120,
      tests_failed: 3,
      failures: ['parser > empty input'],
      checks_that_exited_with_an_error: ['API_TOKEN=<redacted> npm test'],
    })
  })

  test('a quoted span that cuts the command still finds it', () => {
    expect(parseFacts(says({ check_commands: { type: 'list', value: ['npm test'], confidence: 0.9 } }), after)!.errored).toEqual(['API_TOKEN=<redacted> npm test'])
  })

  test('a failing command that is no check does not count', () => {
    const grep = commandsAfter({ request: 'r', steps: [{ kind: 'change', path: '/p/a.ts' }, { kind: 'command', command: 'grep -r TODO src', failed: true, output: '' }] })
    expect(parseFacts(says({ check_commands: { type: 'list', value: [], confidence: 0.9 } }), grep)!.errored).toEqual([])
  })

  test('leaves out what Clairic is not sure of', () => {
    const facts = parseFacts(says({ failures: { type: 'list', value: ['maybe'], confidence: 0.3 }, passed_counts: { type: 'list', value: [], confidence: 0.9 } }), after)!
    expect(facts.failures).toBeUndefined()
    expect(facts.passed).toBeUndefined()
    expect(extractedOf(facts)).toEqual({ check_commands: ['API_TOKEN=s3cr3t npm test'], tests_failed: 3, checks_that_exited_with_an_error: ['API_TOKEN=<redacted> npm test'] })
  })

  test('rejects what is not an answer', () => {
    expect(parseFacts('nope', after)).toBeUndefined()
    expect(parseFacts(JSON.stringify({ result: { answers: 'x' } }), after)).toBeUndefined()
    expect(parseFacts(JSON.stringify({ answers: { check_commands: { value: 'x', confidence: 1 } } }), after)).toBeUndefined()
  })
})

describe('evidenceOf', () => {
  test('the failures behind a failing check, and the test counts', () => {
    expect(evidenceOf(parseFacts(says(), after)!)).toEqual({
      evidence: { failing: ['失敗 3 個', 'parser > empty input', 'API_TOKEN=<redacted> npm test（結束時回報錯誤）'] },
      tests: { passed: 120, failed: 3 },
    })
  })

  test('no failure, no evidence', () => {
    const passing = commandsAfter({ request: 'r', steps: [{ kind: 'change', path: '/p/a.ts' }, { kind: 'command', command: 'npm test', failed: false, output: '120 passed' }] })
    const facts = parseFacts(
      says({ check_commands: { type: 'list', value: ['npm test'], confidence: 0.9 }, failed_counts: { type: 'list', value: [0], confidence: 0.9 }, failures: { type: 'list', value: [], confidence: 0.9 } }),
      passing,
    )!
    expect(evidenceOf(facts)).toEqual({ tests: { passed: 120, failed: 0 } })
  })
})
