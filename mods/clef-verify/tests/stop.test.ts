import type { HttpInit, On, OpEventResult, SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const ENV = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'test-token', HOME: '/home/me' }

type Sent = { url: string; init?: HttpInit }

function reply(status: number, text: string): OpEventResult<'http.fetch'> {
  return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } }
}

/** Clef answering every question; `checked` low means the tests were not run. */
function clefSays(answers: Record<string, number>): string {
  const all = { needs_check: 0.9, checked: 0.95, passed: 0.95, claims_ok: 0.9, unfinished: 0.05, asks_user: 0.02, ...answers }
  return JSON.stringify({ success: true, result: { answers: Object.fromEntries(Object.entries(all).map(([id, p]) => [id, { type: 'noul', noul: p }])) } })
}

function clef(on: On, text: string): Sent[] {
  const sent: Sent[] = []
  on('http.fetch', async (_$, e) => {
    sent.push(e)
    return reply(200, text)
  })
  return sent
}

/** What the hooks beneath clef-verify answer at Stop: nothing, unless a test sets `block`. */
type Beneath = { block?: string }

/** A session in /home/me/proj whose transcript is `messages`, on the person's `turns()`th prompt. */
function session(on: On, messages: SessionMessage[], turns: () => number = () => 1): Beneath {
  const beneath: Beneath = {}
  on('session.root', async () => ({ value: '/home/me/proj' }))
  on('session.turns', async () => ({ value: turns() }))
  on('session.messages', async () => ({ value: messages }))
  on('classic.Stop', async () => (beneath.block ? { block: beneath.block } : {}))
  return beneath
}

const EDITED: SessionMessage[] = [
  { role: 'user', text: 'fix the parser bug', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e', tool: 'Edit', input: { file_path: '/home/me/proj/src/parser.ts' }, text: 'ok' }] },
  { role: 'user', text: '', toolUses: [], toolResults: [] },
  { role: 'assistant', text: 'Fixed, tests pass.', toolUses: [] },
]

const stop = { stop_hook_active: false, last_assistant_message: 'Fixed, tests pass.' }

describe('the Stop check', () => {
  test('sends Claude back when changed code was not tested', async ($, on) => {
    mock.env(on, ENV)
    mock.clock(on)
    session(on, EDITED)
    const sent = clef(on, clefSays({ checked: 0.05, claims_ok: 0.1 }))

    const result = await $.classic.Stop(stop)
    expect(result.block).toContain('沒有跑測試')
    expect(result.block).toContain('步驟裡看不到依據')

    expect(sent[0]?.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef')
    expect(sent[0]?.init?.headers?.Authorization).toBe('Bearer test-token')
    const body = JSON.parse(String(sent[0]?.init?.body))
    expect(body.state).toEqual({ request: 'fix the parser bug', steps: [{ step: 1, changed: './src/parser.ts' }], final_message: 'Fixed, tests pass.' })
  })

  test('lets a verified turn end', async ($, on) => {
    mock.env(on, ENV)
    mock.clock(on)
    session(on, EDITED)
    clef(on, clefSays({}))

    expect((await $.classic.Stop(stop)).block).toBeUndefined()
  })

  test('lets a docs-only change end without tests', async ($, on) => {
    mock.env(on, ENV)
    mock.clock(on)
    session(on, EDITED)
    clef(on, clefSays({ needs_check: 0.05, checked: 0, passed: 0 }))

    expect((await $.classic.Stop(stop)).block).toBeUndefined()
  })

  test('asks Clef nothing for a turn that changed no file', async ($, on) => {
    mock.env(on, ENV)
    mock.clock(on)
    session(on, [{ role: 'user', text: 'what does this do?', toolUses: [] }, { role: 'assistant', text: 'It parses.', toolUses: [] }])
    const sent = clef(on, clefSays({ checked: 0 }))

    expect((await $.classic.Stop(stop)).block).toBeUndefined()
    expect(sent.length).toBe(0)
  })

  test('sends back at most maxRetries times per prompt, then tells the person', { options: { maxRetries: 2 } }, async ($, on) => {
    mock.env(on, ENV)
    mock.clock(on)
    session(on, EDITED)
    clef(on, clefSays({ checked: 0.05 }))
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })

    expect((await $.classic.Stop(stop)).block).toBeDefined()
    expect((await $.classic.Stop({ ...stop, stop_hook_active: true })).block).toBeDefined()
    expect((await $.classic.Stop({ ...stop, stop_hook_active: true })).block).toBeUndefined()
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toContain('沒跑檢查')
  })

  test('counts afresh for the next prompt', { options: { maxRetries: 1 } }, async ($, on) => {
    mock.env(on, ENV)
    mock.clock(on)
    let turns = 1
    session(on, EDITED, () => turns)
    clef(on, clefSays({ checked: 0.05 }))

    expect((await $.classic.Stop(stop)).block).toBeDefined()
    expect((await $.classic.Stop(stop)).block).toBeUndefined()
    turns = 2
    expect((await $.classic.Stop(stop)).block).toBeDefined()
  })

  test('leaves alone a turn another hook blocked, or one waiting on background work', async ($, on) => {
    mock.env(on, ENV)
    mock.clock(on)
    const beneath = session(on, EDITED)
    const sent = clef(on, clefSays({ checked: 0 }))

    const waiting = await $.classic.Stop({ ...stop, background_tasks: [{ id: 't', type: 'shell', status: 'running', description: 'npm test' }] as never })
    expect(waiting.block).toBeUndefined()
    expect(sent.length).toBe(0)

    beneath.block = 'other'
    expect((await $.classic.Stop(stop)).block).toBe('other')
    expect(sent.length).toBe(0)
  })

  test('fails open when Clef errors, is slow, or has no credentials', async ($, on) => {
    mock.env(on, ENV)
    const clock = mock.clock(on)
    session(on, EDITED)
    let mode: 'error' | 'slow' = 'error'
    on('http.fetch', () => (mode === 'error' ? Promise.resolve(reply(500, '{}')) : new Promise<OpEventResult<'http.fetch'>>(() => {})))

    expect((await $.classic.Stop(stop)).block).toBeUndefined()
    mode = 'slow'
    const result = $.classic.Stop(stop)
    await clock.advance(5_000)
    expect((await result).block).toBeUndefined()
  })

  test('does nothing without credentials', async ($, on) => {
    mock.env(on, {})
    mock.clock(on)
    session(on, EDITED)
    const sent = clef(on, clefSays({ checked: 0 }))

    expect((await $.classic.Stop(stop)).block).toBeUndefined()
    expect(sent.length).toBe(0)
  })
})
