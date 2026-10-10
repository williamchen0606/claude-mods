import type { EngineInterface, Register } from 'claude-code'

import { blockOf, changedFiles, endpoint, errorOf, findingsOf, gaveUpToast, modelOf, parseVerdict, requestBody, statusOf, turnOf } from './verify'
import type { ClefModel, Turn, Verdict, Where } from './verify'

/** How long a judgment may take before the turn ends without one, in ms. */
const TIMEOUT_MS = 5_000

/** How many times Claude is sent back per prompt; the reference to that count. */
const RETRIES = { plugin: 'clef-verify', key: 'retries' } as const

type Credentials = { accountId: string; apiToken: string }

/** The settings' values first, then the environment's; undefined when either half is missing. */
async function credentials($: EngineInterface, options: Record<string, unknown>): Promise<Credentials | undefined> {
  const accountId = (typeof options.accountId === 'string' && options.accountId.trim()) || (await $.env.get('CLOUDFLARE_ACCOUNT_ID'))?.trim()
  const apiToken = (typeof options.apiToken === 'string' && options.apiToken.trim()) || (await $.env.get('CLOUDFLARE_API_TOKEN'))?.trim()
  return accountId && apiToken ? { accountId, apiToken } : undefined
}

async function attempt<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/** Asks Clef about the turn; resolves with its verdict, or rejects with a short reason. */
async function judge($: EngineInterface, creds: Credentials, model: ClefModel, turn: Turn, finalMessage: string, where: Where): Promise<Verdict> {
  const request = $.http.fetch(endpoint(creds.accountId, model), {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.apiToken}`, 'Content-Type': 'application/json' },
    body: requestBody(model, turn, finalMessage, where),
  })
  const timeout = $.clock.sleep(TIMEOUT_MS).then(() => {
    throw new Error('逾時')
  })
  const response = await Promise.race([request, timeout])
  if (!response.ok) throw new Error(errorOf(response.status, response.text))
  const verdict = parseVerdict(response.text)
  if (!verdict) throw new Error('回應格式不符')
  return verdict
}

export const register: Register = (on, options) => {
  const model = modelOf(options.model)
  const threshold = typeof options.threshold === 'number' ? options.threshold : 0.7
  const maxRetries = typeof options.maxRetries === 'number' ? Math.max(0, Math.floor(options.maxRetries)) : 2

  // Fails open: a check that cannot be had lets the turn end as it would.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    // Another hook already decided, or the session waits on background work and is not done.
    if (result.block || result.preventContinuation || e.background_tasks?.length) return result

    const messages = (await attempt(() => $.session.messages())) ?? []
    const turn = turnOf(messages)
    if (!turn || !changedFiles(turn)) return result

    const creds = await credentials($, options)
    if (!creds) {
      $.ui.status('Clef 未設定：缺少 Account ID 或 API Token')
      return result
    }

    const [root, home, turns] = await Promise.all([attempt(() => $.session.root()), attempt(() => $.env.get('HOME')), attempt(() => $.session.turns())])
    const finalMessage = e.last_assistant_message ?? messages.findLast(message => message.role === 'assistant' && message.text)?.text ?? ''

    const started = await $.clock.now()
    let verdict: Verdict
    try {
      verdict = await judge($, creds, model, turn, finalMessage, { root, home })
    } catch (error) {
      $.ui.status(`Clef 未判斷：${error instanceof Error ? error.message : String(error)}`)
      return result
    }
    const ms = (await $.clock.now()) - started

    const findings = findingsOf(verdict, threshold)
    if (!findings.length) {
      $.ui.status(statusOf(verdict, findings, ms, { kind: 'passed' }))
      return result
    }

    // The count belongs to the prompt: its turn number and opening text.
    const prompt = `${turns ?? ''}|${turn.request.slice(0, 200)}`
    const retries = (await $.state.get(RETRIES)).value
    const count = retries?.prompt === prompt ? retries.count : 0
    if (count >= maxRetries) {
      $.ui.status(statusOf(verdict, findings, ms, { kind: 'gave-up', max: maxRetries }))
      if (maxRetries > 0) $.ui.toast(gaveUpToast(findings))
      return result
    }
    await $.state.set(RETRIES, { prompt, count: count + 1 })
    $.ui.status(statusOf(verdict, findings, ms, { kind: 'sent-back', count: count + 1, max: maxRetries }))
    return { ...result, block: blockOf(findings) }
  }).catch(($, e, next) => next(e))
}
