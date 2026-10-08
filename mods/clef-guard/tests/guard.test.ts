import type { HttpInit, OpEventResult } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const ENV = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'test-token' }

/** A Workers AI response putting `risky` on the destructive level and the rest on the harmless ones. */
function clefSays(risky: number): string {
  const rest = (1 - risky) / 3
  return JSON.stringify({
    success: true,
    errors: [],
    result: { answers: { risk: { probabilities: { '0': rest, '1': rest, '2': rest, '3': 0, '4': risky } } } },
  })
}

type Sent = { url: string; init?: HttpInit }

/** What a `$.http.fetch` answers. */
function reply(status: number, text: string): OpEventResult<'http.fetch'> {
  return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } }
}

describe('the Bash permission check', () => {
  test('asks for a command Clef finds risky', async ($, on) => {
    mock.env(on, ENV)
    mock.clock(on)
    const sent: Sent[] = []
    on('http.fetch', async (_$, e) => {
      sent.push(e)
      return reply(200, clefSays(0.9))
    })
    on('tool.check', async () => ({ decision: 'allow' as const }))

    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'API_TOKEN=s3cr3t rm -rf ~' } })
    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toContain('90%')

    expect(sent.length).toBe(1)
    expect(sent[0]?.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef')
    expect(sent[0]?.init?.headers?.Authorization).toBe('Bearer test-token')
    // The secret in the command never leaves the machine.
    expect(sent[0]?.init?.body).not.toContain('s3cr3t')
  })

  test('lets a harmless command through', async ($, on) => {
    mock.env(on, ENV)
    mock.clock(on)
    on('http.fetch', async () => (reply(200, clefSays(0.02))))
    on('tool.check', async () => ({ decision: 'allow' as const }))

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('allow')
  })

  test('uses the model and threshold from the settings', { options: { model: 'clef-flash', threshold: 0.95, accountId: 'mine', apiToken: 'cfg-token' } }, async ($, on) => {
    mock.env(on, ENV)
    mock.clock(on)
    const sent: Sent[] = []
    on('http.fetch', async (_$, e) => {
      sent.push(e)
      return reply(200, clefSays(0.9))
    })
    on('tool.check', async () => ({ decision: 'allow' as const }))

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })).decision).toBe('allow')
    expect(sent[0]?.url).toBe('https://api.cloudflare.com/client/v4/accounts/mine/ai/run/@cf/cloudflare/clef-flash')
    expect(sent[0]?.init?.headers?.Authorization).toBe('Bearer cfg-token')
  })

  test('never loosens a deny, and asks Clef nothing for it', async ($, on) => {
    mock.env(on, ENV)
    mock.clock(on)
    let calls = 0
    on('http.fetch', async () => {
      calls++
      return reply(200, clefSays(0))
    })
    on('tool.check', async () => ({ decision: 'deny' as const, reason: 'rule' }))

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('deny')
    expect(calls).toBe(0)
  })

  test('fails open when Clef errors', async ($, on) => {
    mock.env(on, ENV)
    mock.clock(on)
    on('http.fetch', async () => reply(403, '{"success":false,"errors":[{"message":"Authentication error"}]}'))
    on('tool.check', async () => ({ decision: 'allow' as const }))

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf ~' } })).decision).toBe('allow')
  })

  test('fails open when Clef is slow', async ($, on) => {
    mock.env(on, ENV)
    const clock = mock.clock(on)
    on('http.fetch', () => new Promise<OpEventResult<'http.fetch'>>(() => {}))
    on('tool.check', async () => ({ decision: 'allow' as const }))

    const verdict = $.tool.check({ tool: 'Bash', input: { command: 'rm -rf ~' } })
    await clock.advance(2_000)
    expect((await verdict).decision).toBe('allow')
  })

  test('does nothing without credentials', async ($, on) => {
    mock.env(on, {})
    mock.clock(on)
    let calls = 0
    on('http.fetch', async () => {
      calls++
      return reply(200, clefSays(1))
    })
    on('tool.check', async () => ({ decision: 'allow' as const }))

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf ~' } })).decision).toBe('allow')
    expect(calls).toBe(0)
  })
})
