import { describe, expect, test } from 'claude-code/testing'

import { APPROVE, REFUSE, endpoint, errorOf, modelOf, needsConfirm, parseRisk, questionOf, redact, requestBody, statusOf, verdictOf } from '../hooks/clef'

/** A Workers AI response for the risk question, enveloped as the REST API sends it. */
function response(probabilities: Record<string, number>): string {
  return JSON.stringify({
    success: true,
    errors: [],
    result: {
      model: 'clef',
      answers: { risk: { type: 'score', score: 0, legend: {}, probabilities, confidence: 0.9 } },
      usage: { input_tokens: 300, output_tokens: 0 },
    },
  })
}

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

describe('request', () => {
  test('names the model and sends the redacted command', () => {
    expect(endpoint('abc123', 'clef-flash')).toBe('https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/cloudflare/clef-flash')
    const body = JSON.parse(requestBody('clef', 'TOKEN=s3cr3t rm -rf /'))
    expect(body.model).toBe('clef')
    expect(body.state.command).toBe('TOKEN=<redacted> rm -rf /')
    expect(body.questions.risk.type).toBe('score')
    expect(body.questions.risk.criteria.length).toBe(5)
  })

  test('takes clef-omni like the other models', () => {
    expect(endpoint('abc123', 'clef-omni')).toBe('https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/cloudflare/clef-omni')
    expect(JSON.parse(requestBody('clef-omni', 'ls')).model).toBe('clef-omni')
  })

  test('reads the model from the settings, falling back to clef', () => {
    expect(modelOf('clef-flash')).toBe('clef-flash')
    expect(modelOf('clef-omni')).toBe('clef-omni')
    expect(modelOf('clef')).toBe('clef')
    expect(modelOf('clef-ultra')).toBe('clef')
    expect(modelOf(undefined)).toBe('clef')
  })
})

describe('parseRisk', () => {
  test('sums the risky levels and picks the likeliest', () => {
    expect(parseRisk(response({ '0': 0.1, '1': 0.1, '2': 0.1, '3': 0.3, '4': 0.4 }))).toEqual({ risky: 0.7, level: 4 })
    expect(parseRisk(response({ '0': 0.9, '1': 0.05, '2': 0.05, '3': 0, '4': 0 }))).toEqual({ risky: 0, level: 0 })
  })

  test('reads a bare body too', () => {
    const bare = JSON.stringify({ answers: { risk: { probabilities: { '1': 0.6, '3': 0.4 } } } })
    expect(parseRisk(bare)).toEqual({ risky: 0.4, level: 1 })
  })

  test('rejects what is not an answer', () => {
    expect(parseRisk('not json')).toBeUndefined()
    expect(parseRisk(JSON.stringify({ result: { answers: {} } }))).toBeUndefined()
    expect(parseRisk(JSON.stringify({ result: { answers: { risk: { probabilities: { x: 1 } } } } }))).toBeUndefined()
  })

  test('errors carry the API message', () => {
    expect(errorOf(403, JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }))).toBe('HTTP 403: Authentication error')
    expect(errorOf(502, '<html>')).toBe('HTTP 502')
  })
})

describe('confirmation', () => {
  const risky = { risky: 0.8, level: 4 }
  const safe = { risky: 0.1, level: 0 }

  test('asks only for a risky call the engine did not refuse', () => {
    expect(needsConfirm('allow', risky, 0.5)).toBe(true)
    expect(needsConfirm('ask', risky, 0.5)).toBe(true)
    expect(needsConfirm('deny', risky, 0.5)).toBe(false)
    expect(needsConfirm('allow', safe, 0.5)).toBe(false)
    expect(needsConfirm('allow', risky, 0.9)).toBe(false)
  })

  test('the question shows the risk and the command', () => {
    const question = questionOf(risky, 'rm -rf build')
    expect(question).toContain('80%')
    expect(question).toContain('破壞性')
    expect(question).toContain('rm -rf build')
    expect(question.endsWith('？')).toBe(true)
    expect(questionOf(risky, 'x'.repeat(500))).toContain(`${'x'.repeat(300)}…`)
  })

  test('only an explicit yes runs the command', () => {
    expect(verdictOf(APPROVE).decision).toBe('allow')
    expect(verdictOf(REFUSE)).toEqual({ decision: 'deny', reason: 'clef-guard：使用者拒絕執行這條指令。' })
    expect(verdictOf('')).toEqual({ decision: 'deny', reason: 'clef-guard：使用者拒絕執行這條指令。' })
    expect(verdictOf('先備份再刪')).toEqual({ decision: 'deny', reason: 'clef-guard：使用者拒絕執行這條指令，並回覆：先備份再刪' })
  })

  test('status line', () => {
    expect(statusOf(safe, 40)).toBe('Clef 風險 10% · 無害 · 40ms')
    expect(statusOf(risky, 212.4, 'asking')).toBe('Clef 風險 80% · 破壞性 · 212ms · 等你確認')
    expect(statusOf(risky, 212.4, 'allowed')).toBe('Clef 風險 80% · 破壞性 · 212ms · 你已確認')
    expect(statusOf(risky, 212.4, 'refused')).toBe('Clef 風險 80% · 破壞性 · 212ms · 已拒絕')
  })
})
