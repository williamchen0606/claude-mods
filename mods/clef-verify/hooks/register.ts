import type { EngineInterface, Register } from 'claude-code'

import { clairicBody, commandsAfter, evidenceOf, extractedOf, parseFacts } from './clairic'
import type { Facts } from './clairic'
import { blockOf, changedFiles, endpoint, errorOf, extractorOf, findingsOf, gaveUpToast, modelOf, parseVerdict, requestBody, statusOf, turnOf } from './verify'
import type { ClefModel, Turn, Verdict, Where } from './verify'

/** How long Clef's judgment may take before the turn ends without one, in ms. */
const TIMEOUT_MS = 5_000
/** How long Clairic may take before Clef judges without its facts, in ms. */
const EXTRACT_TIMEOUT_MS = 3_000

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

/** Posts `body` to `model` and reads the answer with `parse`; resolves with it, or rejects with a short reason. */
async function ask<T>(
  $: EngineInterface,
  creds: Credentials,
  model: ClefModel | 'clairic',
  body: string,
  ms: number,
  parse: (text: string) => T | undefined,
): Promise<T> {
  const request = $.http.fetch(endpoint(creds.accountId, model), {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.apiToken}`, 'Content-Type': 'application/json' },
    body,
  })
  const timeout = $.clock.sleep(ms).then(() => {
    throw new Error('逾時')
  })
  const response = await Promise.race([request, timeout])
  if (!response.ok) throw new Error(errorOf(response.status, response.text))
  const answer = parse(response.text)
  if (answer === undefined) throw new Error('回應格式不符')
  return answer
}

/**
 * Has Clairic read the output of the commands after the last change. No
 * command, nothing to read. A failure leaves Clef to judge without the
 * facts, with the reason for the status line.
 */
async function extract($: EngineInterface, creds: Credentials, turn: Turn): Promise<{ facts?: Facts; failed?: string }> {
  const commands = commandsAfter(turn)
  if (!commands.length) return {}
  try {
    return { facts: await ask($, creds, 'clairic', clairicBody(commands), EXTRACT_TIMEOUT_MS, text => parseFacts(text, commands)) }
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) }
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const register: Register = (on, options) => {
  const model = modelOf(options.model)
  const extractor = extractorOf(options.extractor)
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
    const { facts, failed } = extractor === 'clairic' ? await extract($, creds, turn) : {}
    const where: Where = { root, home }
    let verdict: Verdict
    try {
      const said = await ask($, creds, model, requestBody(model, turn, finalMessage, where, facts && extractedOf(facts)), TIMEOUT_MS, parseVerdict)
      verdict = { ...said, ...(facts ? evidenceOf(facts) : {}) }
    } catch (error) {
      $.ui.status(`Clef 未判斷：${reason(error)}`)
      return result
    }
    const ms = (await $.clock.now()) - started
    const status = (text: string) => $.ui.status(failed ? `${text} · Clairic 未抽取：${failed}` : text)

    const findings = findingsOf(verdict, threshold)
    if (!findings.length) {
      status(statusOf(verdict, findings, ms, { kind: 'passed' }))
      return result
    }

    // The count belongs to the prompt: its turn number and opening text.
    const prompt = `${turns ?? ''}|${turn.request.slice(0, 200)}`
    const retries = (await $.state.get(RETRIES)).value
    const count = retries?.prompt === prompt ? retries.count : 0
    if (count >= maxRetries) {
      status(statusOf(verdict, findings, ms, { kind: 'gave-up', max: maxRetries }))
      if (maxRetries > 0) $.ui.toast(gaveUpToast(findings))
      return result
    }
    await $.state.set(RETRIES, { prompt, count: count + 1 })
    status(statusOf(verdict, findings, ms, { kind: 'sent-back', count: count + 1, max: maxRetries }))
    return { ...result, block: blockOf(findings, verdict.evidence) }
  }).catch(($, e, next) => next(e))
}
