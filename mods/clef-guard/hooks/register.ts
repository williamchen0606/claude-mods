import type { EngineInterface, Register } from 'claude-code'

import { APPROVE, REFUSE, UNANSWERED, endpoint, errorOf, modelOf, needsConfirm, parseRisk, questionOf, requestBody, statusOf, verdictOf } from './clef'
import type { ClefModel, Risk } from './clef'

/** How long a judgment may take before the command goes on without one, in ms. */
const TIMEOUT_MS = 2_000

type Credentials = { accountId: string; apiToken: string }

/** The settings' values first, then the environment's; undefined when either half is missing. */
async function credentials($: EngineInterface, options: Record<string, unknown>): Promise<Credentials | undefined> {
  const accountId = (typeof options.accountId === 'string' && options.accountId.trim()) || (await $.env.get('CLOUDFLARE_ACCOUNT_ID'))?.trim()
  const apiToken = (typeof options.apiToken === 'string' && options.apiToken.trim()) || (await $.env.get('CLOUDFLARE_API_TOKEN'))?.trim()
  return accountId && apiToken ? { accountId, apiToken } : undefined
}

/** Asks Clef about `command`; resolves with its risk, or rejects with a short reason. */
async function judge($: EngineInterface, creds: Credentials, model: ClefModel, command: string): Promise<Risk> {
  const request = $.http.fetch(endpoint(creds.accountId, model), {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.apiToken}`, 'Content-Type': 'application/json' },
    body: requestBody(model, command),
  })
  const timeout = $.clock.sleep(TIMEOUT_MS).then(() => {
    throw new Error('逾時')
  })
  const response = await Promise.race([request, timeout])
  if (!response.ok) throw new Error(errorOf(response.status, response.text))
  const risk = parseRisk(response.text)
  if (!risk) throw new Error('回應格式不符')
  return risk
}

export const register: Register = (on, options) => {
  const model = modelOf(options.model)
  const threshold = typeof options.threshold === 'number' ? options.threshold : 0.5

  // Fails open: Clef is an extra signal on top of the permission rules, so a
  // judgment that cannot be had leaves the engine's own verdict standing. Once
  // Clef finds a command risky, only the person's explicit yes runs it.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    const command = (e.input as { command?: unknown } | undefined)?.command
    if (verdict.decision === 'deny' || typeof command !== 'string' || !command.trim()) return verdict

    const creds = await credentials($, options)
    if (!creds) {
      $.ui.status('Clef 未設定：缺少 Account ID 或 API Token')
      return verdict
    }

    const started = await $.clock.now()
    let risk: Risk
    try {
      risk = await judge($, creds, model, command)
    } catch (error) {
      $.ui.status(`Clef 未判斷：${error instanceof Error ? error.message : String(error)}`)
      return verdict
    }

    const ms = (await $.clock.now()) - started
    if (!needsConfirm(verdict.decision, risk, threshold)) {
      $.ui.status(statusOf(risk, ms))
      return verdict
    }

    // Asked here rather than answered with `ask`: an ask goes to the mode's
    // decider, which under auto mode is a classifier, not the person.
    $.ui.status(statusOf(risk, ms, 'asking'))
    let answer: string
    try {
      answer = await $.ui.ask(questionOf(risk, command), { header: 'clef-guard', options: [APPROVE, REFUSE] })
    } catch {
      $.ui.status(statusOf(risk, ms, 'refused'))
      return { decision: 'deny', reason: UNANSWERED }
    }
    const decided = verdictOf(answer)
    $.ui.status(statusOf(risk, ms, decided.decision === 'allow' ? 'allowed' : 'refused'))
    return decided
  }).catch(($, e, next) => next(e))
}
