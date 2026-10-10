import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { blockOf, changedFiles, endpoint, errorOf, findingsOf, modelOf, parseVerdict, placeOf, requestBody, stateOf, statusOf, turnOf } from '../hooks/verify'
import type { Turn } from '../hooks/verify'

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const results = (): SessionMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [] })
const uses = (...toolUses: SessionMessage['toolUses']): SessionMessage => ({ role: 'assistant', text: '', toolUses })
const said = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })
const edit = (path: string, isError?: true) => ({ tool_use_id: path, tool: 'Edit', input: { file_path: path }, text: 'ok', ...(isError ? { isError } : {}) })
const bash = (command: string, text: string, isError?: true) => ({ tool_use_id: command, tool: 'Bash', input: { command }, text, ...(isError ? { isError } : {}) })

describe('turnOf', () => {
  test('starts at the latest prompt and keeps the steps in order', () => {
    const turn = turnOf([
      prompt('old request'),
      uses(edit('/p/old.ts')),
      results(),
      said('done'),
      prompt('fix the parser'),
      uses({ tool_use_id: 'r', tool: 'Read', input: { file_path: '/p/a.ts' } }, edit('/p/a.ts')),
      results(),
      uses(bash('npm test', '1 failing', true), { tool_use_id: 'w', tool: 'Write', input: { file_path: '/p/b.ts' } }),
      results(),
      uses({ tool_use_id: 'n', tool: 'NotebookEdit', input: { notebook_path: '/p/c.ipynb' } }, edit('/p/bad.ts', true)),
      said('fixed'),
    ])
    expect(turn).toEqual({
      request: 'fix the parser',
      steps: [
        { kind: 'change', path: '/p/a.ts' },
        { kind: 'command', command: 'npm test', failed: true, output: '1 failing' },
        { kind: 'change', path: '/p/b.ts' },
        { kind: 'change', path: '/p/c.ipynb' },
      ],
    })
    expect(changedFiles(turn!)).toBe(true)
  })

  test('a turn that only ran commands changed no file', () => {
    const turn = turnOf([prompt('what is in here?'), uses(bash('ls', 'a b')), results(), said('a and b')])
    expect(changedFiles(turn!)).toBe(false)
  })

  test('no prompt, no turn', () => {
    expect(turnOf([])).toBeUndefined()
    expect(turnOf([results(), said('hi')])).toBeUndefined()
  })
})

describe('request', () => {
  const turn: Turn = {
    request: 'deploy with API_TOKEN=s3cr3t',
    steps: [
      { kind: 'change', path: '/home/me/proj/src/a.ts' },
      { kind: 'command', command: 'npm test', failed: false, output: `${'x'.repeat(700)}all passed` },
    ],
  }

  test('places paths, clips output to its end and redacts', () => {
    expect(placeOf('/home/me/proj/a.ts', '/home/me/proj', '/home/me')).toBe('./a.ts')
    expect(placeOf('/home/me/.bashrc', '/home/me/proj', '/home/me')).toBe('~/.bashrc')
    expect(placeOf('/etc/hosts', '/home/me/proj')).toBe('/etc/hosts')

    const state = stateOf(turn, 'Done, tests pass.', { root: '/home/me/proj', home: '/home/me' })
    expect(state.request).toBe('deploy with API_TOKEN=<redacted>')
    expect(state.final_message).toBe('Done, tests pass.')
    const steps = state.steps as Record<string, unknown>[]
    expect(steps[0]).toEqual({ step: 1, changed: './src/a.ts' })
    expect(steps[1]?.ran).toBe('npm test')
    expect(steps[1]?.failed).toBe(false)
    expect(String(steps[1]?.output_tail).endsWith('all passed')).toBe(true)
    expect(String(steps[1]?.output_tail).length).toBe(601)
  })

  test('keeps the latest steps of each kind, numbered as they happened', () => {
    const many: Turn = {
      request: 'r',
      steps: [
        { kind: 'change', path: '/p/first.ts' },
        ...Array.from({ length: 30 }, (_, i) => ({ kind: 'command' as const, command: `cmd ${i}`, failed: false, output: '' })),
      ],
    }
    const steps = stateOf(many, '', {}).steps as Record<string, unknown>[]
    expect(steps.length).toBe(21)
    expect(steps[0]).toEqual({ step: 1, changed: '/p/first.ts' })
    expect(steps[1]?.step).toBe(12)
    expect(steps[20]?.ran).toBe('cmd 29')
  })

  test('asks the six questions', () => {
    expect(endpoint('abc', 'clef-flash')).toBe('https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/cloudflare/clef-flash')
    const body = JSON.parse(requestBody('clef', turn, 'done', {}))
    expect(body.model).toBe('clef')
    expect(Object.keys(body.questions)).toEqual(['needs_check', 'checked', 'passed', 'claims_ok', 'unfinished', 'asks_user'])
    for (const question of Object.values(body.questions) as { type: string }[]) expect(question.type).toBe('noul')
  })

  test('reads the model from the settings, falling back to clef', () => {
    expect(modelOf('clef-omni')).toBe('clef-omni')
    expect(modelOf('nope')).toBe('clef')
  })
})

describe('parseVerdict', () => {
  test('reads each noul answer', () => {
    const text = JSON.stringify({
      success: true,
      result: { answers: { needs_check: { type: 'noul', noul: 0.9 }, checked: { type: 'noul', noul: 0.1 }, asks_user: { noul: 2 } } },
    })
    expect(parseVerdict(text)).toEqual({ needsCheck: 0.9, checked: 0.1 })
    expect(parseVerdict(JSON.stringify({ answers: { passed: { noul: 0.4 } } }))).toEqual({ passed: 0.4 })
  })

  test('rejects what is not an answer', () => {
    expect(parseVerdict('nope')).toBeUndefined()
    expect(parseVerdict(JSON.stringify({ result: { answers: {} } }))).toBeUndefined()
    expect(errorOf(401, JSON.stringify({ errors: [{ message: 'Bad token' }] }))).toBe('HTTP 401: Bad token')
  })
})

describe('findingsOf', () => {
  const good = { needsCheck: 0.9, checked: 0.95, passed: 0.95, claimsOk: 0.9, unfinished: 0.05, asksUser: 0.02 }

  test('nothing missing', () => {
    expect(findingsOf(good, 0.7)).toEqual([])
  })

  test('changes that need a check, without one or with a failing one', () => {
    expect(findingsOf({ ...good, checked: 0.1 }, 0.7)).toEqual(['unchecked'])
    expect(findingsOf({ ...good, checked: 0.4 }, 0.7)).toEqual([])
    expect(findingsOf({ ...good, passed: 0.2 }, 0.7)).toEqual(['failing'])
    expect(findingsOf({ ...good, checked: 0.1, passed: 0.1 }, 0.7)).toEqual(['unchecked'])
  })

  test('changes that need no check, like docs, are not sent back for it', () => {
    expect(findingsOf({ ...good, needsCheck: 0.1, checked: 0, passed: 0 }, 0.7)).toEqual([])
  })

  test('unsupported claims and unfinished requests', () => {
    expect(findingsOf({ ...good, claimsOk: 0.2, unfinished: 0.8 }, 0.7)).toEqual(['unsupported', 'unfinished'])
    expect(findingsOf({ ...good, needsCheck: 0.1, claimsOk: 0.2 }, 0.7)).toEqual(['unsupported'])
  })

  test('nothing is missing while Claude asks the person', () => {
    expect(findingsOf({ ...good, checked: 0, unfinished: 1, asksUser: 0.9 }, 0.7)).toEqual([])
  })

  test('answers Clef did not give find nothing', () => {
    expect(findingsOf({ needsCheck: 0.9 }, 0.7)).toEqual([])
  })
})

describe('messages', () => {
  test('the block lists what is missing', () => {
    const block = blockOf(['unchecked', 'unfinished'])
    expect(block.startsWith('clef-verify：結束前請先處理：\n· 你改了檔案')).toBe(true)
    expect(block).toContain('· 使用者的要求似乎還有沒完成的部分')
    expect(block.endsWith('如果確定不需要，請在回覆中說明原因再結束。')).toBe(true)
  })

  test('status line', () => {
    expect(statusOf({ needsCheck: 0.1 }, [], 312.4, { kind: 'passed' })).toBe('需要檢查 10% · 312ms · 通過')
    expect(statusOf({ needsCheck: 0.9 }, ['unchecked'], 300, { kind: 'sent-back', count: 1, max: 2 })).toBe('需要檢查 90% · 沒跑檢查 · 300ms · 退回 1/2')
    expect(statusOf({}, ['failing', 'unsupported'], 300, { kind: 'gave-up', max: 2 })).toBe('檢查沒過、回覆沒有依據 · 300ms · 已退回 2 次，不再退回')
  })
})
