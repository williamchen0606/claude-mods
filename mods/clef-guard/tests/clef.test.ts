import { describe, expect, test } from 'claude-code/testing'

import { actionOf, placeOf, shownOf, stateOf, toolsOf } from '../hooks/action'
import type { Action } from '../hooks/action'
import { APPROVE, REFUSE, decide, endpoint, errorOf, modelOf, parseJudgment, questionOf, redact, requestBody, statusOf, verdictOf } from '../hooks/clef'
import type { Judgment } from '../hooks/clef'

/** A Workers AI response, enveloped as the REST API sends it. */
function response(probabilities: Record<string, number>, more: Record<string, unknown> = {}): string {
  return JSON.stringify({
    success: true,
    errors: [],
    result: {
      model: 'clef',
      answers: { risk: { type: 'score', score: 0, legend: {}, probabilities, confidence: 0.9 }, ...more },
      usage: { input_tokens: 300, output_tokens: 0 },
    },
  })
}

const bash = (command: string): Action => ({ tool: 'Bash', command })
const none = { requests: [] }

describe('redact', () => {
  test('masks secrets', () => {
    expect(redact('curl -H "Authorization: Bearer abc.def" https://x.dev')).toBe('curl -H "Authorization: Bearer <redacted>" https://x.dev')
    expect(redact('GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaa gh pr list')).toBe('GITHUB_TOKEN=<redacted> gh pr list')
    expect(redact('export API_KEY="hunter2"')).toBe('export API_KEY=<redacted>')
    expect(redact('mysql --password=hunter2 -u root')).toBe('mysql --password=<redacted> -u root')
    expect(redact('git clone https://me:pw@github.com/a/b')).toBe('git clone https://<redacted>@github.com/a/b')
    expect(redact('echo sk-ant-api03-abcdefghijklmnop1234')).toBe('echo <redacted>')
    expect(redact('aws s3 ls --profile AKIAABCDEFGHIJKLMNOP')).toBe('aws s3 ls --profile <redacted>')
    expect(redact('echo Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u')).toBe('echo <redacted>')
  })

  test('leaves ordinary commands alone', () => {
    for (const command of ['rm -rf node_modules', 'git push --force origin main', 'ls -la ~/.ssh', 'npm test -- --watch=false']) {
      expect(redact(command)).toBe(command)
    }
  })
})

describe('actions', () => {
  test('reads each guarded tool', () => {
    expect(actionOf('Bash', { command: 'ls' })).toEqual({ tool: 'Bash', command: 'ls' })
    expect(actionOf('Bash', { command: '  ' })).toBeUndefined()
    expect(actionOf('Write', { file_path: '/p/a.ts', content: 'x' })).toEqual({ tool: 'Write', path: '/p/a.ts', content: 'x' })
    expect(actionOf('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b', replace_all: true })).toEqual({
      tool: 'Edit',
      path: '/p/a.ts',
      oldText: 'a',
      newText: 'b',
      replaceAll: true,
    })
    expect(actionOf('WebFetch', { url: 'https://x.dev', prompt: 'p' })).toEqual({ tool: 'WebFetch', url: 'https://x.dev' })
    expect(actionOf('Read', { file_path: '/p/a.ts' })).toBeUndefined()
    expect(actionOf('Bash', 'ls')).toBeUndefined()
  })

  test('reads the tools setting, falling back to all', () => {
    expect(toolsOf('Bash, webfetch')).toEqual(['Bash', 'WebFetch'])
    expect(toolsOf('')).toEqual(['Bash', 'Write', 'Edit', 'WebFetch'])
    expect(toolsOf('Read')).toEqual(['Bash', 'Write', 'Edit', 'WebFetch'])
    expect(toolsOf(undefined)).toEqual(['Bash', 'Write', 'Edit', 'WebFetch'])
  })

  test('places paths relative to the project, then home', () => {
    const where = { root: '/home/me/proj', home: '/home/me' }
    expect(placeOf('/home/me/proj/src/a.ts', where)).toEqual({ path: './src/a.ts', insideProject: true })
    expect(placeOf('/home/me/.bashrc', where)).toEqual({ path: '~/.bashrc', insideProject: false })
    expect(placeOf('/home/me/project2/a', where)).toEqual({ path: '~/project2/a', insideProject: false })
    expect(placeOf('/etc/hosts', where)).toEqual({ path: '/etc/hosts', insideProject: false })
    expect(placeOf('/etc/hosts', {})).toEqual({ path: '/etc/hosts', insideProject: false })
  })

  test('the state holds the redacted action and the requests', () => {
    const where = { root: '/p', home: '/h', requests: ['fix the TOKEN=abc123 typo'] }
    expect(stateOf(actionOf('Write', { file_path: '/h/.zshrc', content: 'export API_KEY=hunter2' })!, where)).toEqual({
      tool: 'Write',
      path: '~/.zshrc',
      inside_project: false,
      content: 'export API_KEY=<redacted>',
      recent_requests: ['fix the TOKEN=<redacted> typo'],
    })
    const edit = stateOf(actionOf('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'x'.repeat(1500) })!, none)
    expect(edit.path).toBe('/p/a.ts')
    expect(edit.with).toBe(`${'x'.repeat(1000)}…`)
    expect('recent_requests' in edit).toBe(false)
    expect(stateOf(actionOf('WebFetch', { url: 'https://x.dev/?access_token=s3cr3t' })!, none)).toEqual({
      tool: 'WebFetch',
      url: 'https://x.dev/?access_token=<redacted>',
    })
  })

  test('the dialog shows what the action does', () => {
    const where = { root: '/p' }
    expect(shownOf(bash('rm -rf build'), where)).toBe('rm -rf build')
    expect(shownOf(bash('x'.repeat(500)), where)).toBe(`${'x'.repeat(300)}…`)
    expect(shownOf(actionOf('Write', { file_path: '/p/a.ts', content: 'a\nb' })!, where)).toBe('寫入 ./a.ts（2 行）')
    expect(shownOf(actionOf('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b', replace_all: true })!, where)).toBe('修改 ./a.ts（全部取代）')
    expect(shownOf(actionOf('WebFetch', { url: 'https://x.dev' })!, where)).toBe('讀取網址 https://x.dev')
  })
})

describe('request', () => {
  test('names the model and asks every question', () => {
    expect(endpoint('abc123', 'clef-flash')).toBe('https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/cloudflare/clef-flash')
    const body = JSON.parse(requestBody('clef', bash('TOKEN=s3cr3t rm -rf /'), { requests: ['clean up'] }))
    expect(body.model).toBe('clef')
    expect(body.state).toEqual({ tool: 'Bash', command: 'TOKEN=<redacted> rm -rf /', recent_requests: ['clean up'] })
    expect(body.questions.risk.type).toBe('score')
    expect(body.questions.risk.criteria.length).toBe(5)
    expect(body.questions.concern.type).toBe('choice')
    expect(Object.keys(body.questions.concern.criteria)[0]).toBe('none')
    expect(body.questions.read_only.type).toBe('noul')
    expect(body.questions.on_task.type).toBe('noul')
  })

  test('leaves out the task question without requests', () => {
    expect(JSON.parse(requestBody('clef', bash('ls'), none)).questions.on_task).toBeUndefined()
  })

  test('takes clef-omni like the other models', () => {
    expect(endpoint('abc123', 'clef-omni')).toBe('https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/cloudflare/clef-omni')
    expect(JSON.parse(requestBody('clef-omni', bash('ls'), none)).model).toBe('clef-omni')
  })

  test('reads the model from the settings, falling back to clef', () => {
    expect(modelOf('clef-flash')).toBe('clef-flash')
    expect(modelOf('clef-omni')).toBe('clef-omni')
    expect(modelOf('clef')).toBe('clef')
    expect(modelOf('clef-ultra')).toBe('clef')
    expect(modelOf(undefined)).toBe('clef')
  })
})

describe('parseJudgment', () => {
  test('sums the risky levels and picks the likeliest', () => {
    expect(parseJudgment(response({ '0': 0.1, '1': 0.1, '2': 0.1, '3': 0.3, '4': 0.4 }))).toEqual({ risky: 0.7, level: 4 })
    expect(parseJudgment(response({ '0': 0.9, '1': 0.05, '2': 0.05, '3': 0, '4': 0 }))).toEqual({ risky: 0, level: 0 })
  })

  test('reads the concern, read-only and on-task answers', () => {
    const text = response(
      { '4': 0.9, '0': 0.1 },
      {
        concern: { type: 'choice', choice: 'data_loss', probabilities: { none: 0.1, data_loss: 0.7, system: 0.2 }, confidence: 0.6 },
        read_only: { type: 'noul', noul: 0.02 },
        on_task: { type: 'noul', noul: 0.3 },
      },
    )
    expect(parseJudgment(text)).toEqual({ risky: 0.9, level: 4, concern: 'data_loss', readOnly: 0.02, onTask: 0.3 })
  })

  test('drops a concern of none, and answers it cannot read', () => {
    const text = response(
      { '0': 1 },
      { concern: { choice: 'none', probabilities: { none: 0.9, data_loss: 0.1 } }, read_only: { noul: 'yes' }, on_task: { noul: 2 } },
    )
    expect(parseJudgment(text)).toEqual({ risky: 0, level: 0 })
  })

  test('reads a bare body too', () => {
    const bare = JSON.stringify({ answers: { risk: { probabilities: { '1': 0.6, '3': 0.4 } } } })
    expect(parseJudgment(bare)).toEqual({ risky: 0.4, level: 1 })
  })

  test('rejects what is not an answer', () => {
    expect(parseJudgment('not json')).toBeUndefined()
    expect(parseJudgment(JSON.stringify({ result: { answers: {} } }))).toBeUndefined()
    expect(parseJudgment(JSON.stringify({ result: { answers: { risk: { probabilities: { x: 1 } } } } }))).toBeUndefined()
  })

  test('errors carry the API message', () => {
    expect(errorOf(403, JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }))).toBe('HTTP 403: Authentication error')
    expect(errorOf(502, '<html>')).toBe('HTTP 502')
  })
})

describe('decide', () => {
  const policy = { threshold: 0.5, autoApprove: false }
  const risky: Judgment = { risky: 0.8, level: 4, concern: 'data_loss', readOnly: 0, onTask: 0.9 }
  const safe: Judgment = { risky: 0.01, level: 0, readOnly: 0.99, onTask: 0.9 }

  test('asks for a risky call the engine did not refuse', () => {
    expect(decide('allow', risky, undefined, policy)).toEqual({
      kind: 'confirm',
      reasons: ['Clef 判斷有 80% 的機率難以復原或具破壞性（最可能：破壞性，刪除資料）'],
    })
    expect(decide('ask', risky, undefined, policy).kind).toBe('confirm')
    expect(decide('deny', risky, undefined, policy).kind).toBe('pass')
    expect(decide('allow', safe, undefined, policy).kind).toBe('pass')
    expect(decide('allow', risky, undefined, { ...policy, threshold: 0.9 }).kind).toBe('pass')
  })

  test('a rule always asks, with or without Clef', () => {
    expect(decide('allow', safe, 'rm -r（遞迴刪除）', policy)).toEqual({ kind: 'confirm', reasons: ['這是一定要問你的操作：rm -r（遞迴刪除）'] })
    expect(decide('allow', undefined, 'rm -r（遞迴刪除）', policy).kind).toBe('confirm')
    expect(decide('ask', safe, 'rm -r（遞迴刪除）', { ...policy, autoApprove: true }).kind).toBe('confirm')
    expect(decide('deny', undefined, 'rm -r（遞迴刪除）', policy).kind).toBe('pass')
    expect(decide('allow', undefined, undefined, policy).kind).toBe('pass')
  })

  test('asks about an off-task action that reaches outside the project', () => {
    const push: Judgment = { risky: 0.1, level: 2, onTask: 0.1 }
    expect(decide('allow', push, undefined, policy)).toEqual({ kind: 'confirm', reasons: ['Clef 判斷這和你最近的要求無關（90%）'] })
    expect(decide('allow', { ...push, level: 1 }, undefined, policy).kind).toBe('pass')
    expect(decide('allow', { ...push, onTask: 0.5 }, undefined, policy).kind).toBe('pass')
    expect(decide('allow', { risky: 0.1, level: 2 }, undefined, policy).kind).toBe('pass')
  })

  test('approves a confident read-only prompt only when asked to', () => {
    const on = { ...policy, autoApprove: true }
    expect(decide('ask', safe, undefined, on)).toEqual({ kind: 'approve' })
    expect(decide('ask', safe, undefined, policy).kind).toBe('pass')
    expect(decide('allow', safe, undefined, on).kind).toBe('pass')
    expect(decide('ask', { ...safe, readOnly: 0.9 }, undefined, on).kind).toBe('pass')
    expect(decide('ask', { ...safe, level: 1 }, undefined, on).kind).toBe('pass')
    expect(decide('ask', { ...safe, onTask: 0.3 }, undefined, on).kind).toBe('pass')
    expect(decide('ask', { risky: 0, level: 0, readOnly: 0.99 }, undefined, on)).toEqual({ kind: 'approve' })
    expect(decide('ask', { risky: 0, level: 0 }, undefined, on).kind).toBe('pass')
  })
})

describe('confirmation', () => {
  test('the question lists the reasons and shows the action', () => {
    const question = questionOf(['這是一定要問你的操作：rm -r（遞迴刪除）', 'Clef 判斷有 80% 的機率難以復原'], 'rm -rf build')
    expect(question).toBe('· 這是一定要問你的操作：rm -r（遞迴刪除）\n· Clef 判斷有 80% 的機率難以復原\n\nrm -rf build\n\n要執行嗎？')
  })

  test('only an explicit yes runs the action', () => {
    expect(verdictOf(APPROVE).decision).toBe('allow')
    expect(verdictOf(REFUSE)).toEqual({ decision: 'deny', reason: 'clef-guard：使用者拒絕執行這個動作。' })
    expect(verdictOf('')).toEqual({ decision: 'deny', reason: 'clef-guard：使用者拒絕執行這個動作。' })
    expect(verdictOf('先備份再刪')).toEqual({ decision: 'deny', reason: 'clef-guard：使用者拒絕執行這個動作，並回覆：先備份再刪' })
  })

  test('status line', () => {
    const risky: Judgment = { risky: 0.8, level: 4, concern: 'data_loss' }
    expect(statusOf('Bash', { risky: 0.1, level: 0 }, 40)).toBe('Bash · Clef 風險 10% · 無害 · 40ms')
    expect(statusOf('Bash', risky, 212.4, 'asking')).toBe('Bash · Clef 風險 80% · 破壞性 · 刪除資料 · 212ms · 等你確認')
    expect(statusOf('Write', risky, 212.4, 'allowed')).toBe('Write · Clef 風險 80% · 破壞性 · 刪除資料 · 212ms · 你已確認')
    expect(statusOf('Bash', undefined, undefined, 'refused', 'rm -r（遞迴刪除）')).toBe('Bash · 必問：rm -r（遞迴刪除） · 已拒絕')
    expect(statusOf('Bash', { risky: 0, level: 0, readOnly: 0.98 }, 50, 'approved')).toBe('Bash · Clef 風險 0% · 無害 · 50ms · 自動放行（唯讀 98%）')
  })
})
