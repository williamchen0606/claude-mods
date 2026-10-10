import type { EngineInterface, Register } from 'claude-code'

import { TOOLS, actionOf, shownOf, toolsOf } from './action'
import type { Action, Context } from './action'
import { APPROVE, REFUSE, UNANSWERED, decide, endpoint, errorOf, modelOf, parseJudgment, questionOf, requestBody, statusOf, verdictOf } from './clef'
import type { ClefModel, Judgment } from './clef'
import { mustAsk, obviouslyReadOnly, prefixesOf } from './rules'

/** How long a judgment may take before the call goes on without one, in ms. */
const TIMEOUT_MS = 2_000

/** How many of the person's latest prompts go to Clef. */
const REQUESTS = 3

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

/** The person's latest prompts in the main conversation, oldest first; tool results are not prompts. */
async function recentRequests($: EngineInterface): Promise<string[]> {
  const messages = (await attempt(() => $.session.messages())) ?? []
  return messages
    .filter(message => message.role === 'user' && !message.toolResults?.length && message.text.trim())
    .slice(-REQUESTS)
    .map(message => message.text.trim())
}

/** Where the session runs, and the requests when `sendRequests` is on. Each part is left out if it cannot be read. */
async function contextOf($: EngineInterface, sendRequests: boolean): Promise<Context> {
  const [root, home, requests] = await Promise.all([
    attempt(() => $.session.root()),
    attempt(() => $.env.get('HOME')),
    sendRequests ? recentRequests($) : Promise.resolve([]),
  ])
  return { root, home, requests }
}

/** Asks Clef about `action`; resolves with its judgment, or rejects with a short reason. */
async function judge($: EngineInterface, creds: Credentials, model: ClefModel, action: Action, context: Context): Promise<Judgment> {
  const request = $.http.fetch(endpoint(creds.accountId, model), {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.apiToken}`, 'Content-Type': 'application/json' },
    body: requestBody(model, action, context),
  })
  const timeout = $.clock.sleep(TIMEOUT_MS).then(() => {
    throw new Error('逾時')
  })
  const response = await Promise.race([request, timeout])
  if (!response.ok) throw new Error(errorOf(response.status, response.text))
  const judgment = parseJudgment(response.text)
  if (!judgment) throw new Error('回應格式不符')
  return judgment
}

export const register: Register = (on, options) => {
  const model = modelOf(options.model)
  const threshold = typeof options.threshold === 'number' ? options.threshold : 0.5
  const tools = toolsOf(options.tools)
  const autoApprove = options.autoApprove === true
  const sendRequests = options.sendRequests !== false
  const prefixes = prefixesOf(options.alwaysAsk)

  // Fails open: Clef is an extra signal on top of the permission rules, so a
  // judgment that cannot be had leaves the engine's own verdict standing,
  // except where a rule says the person must be asked. Once clef-guard stops
  // a call, only the person's explicit yes lets it run.
  on('tool.check', { tool: [...TOOLS] }, async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'deny' || !tools.some(tool => tool === e.tool)) return verdict
    const action = actionOf(e.tool, e.input)
    if (!action) return verdict

    const rule = action.tool === 'Bash' ? mustAsk(action.command, prefixes) : undefined
    // Nothing for Clef to add to a plain read the engine already allows.
    if (!rule && verdict.decision === 'allow' && action.tool === 'Bash' && obviouslyReadOnly(action.command)) return verdict

    let judgment: Judgment | undefined
    let ms: number | undefined
    const creds = await credentials($, options)
    const context = creds ? await contextOf($, sendRequests) : { requests: [] }
    if (!creds) {
      $.ui.status('Clef 未設定：缺少 Account ID 或 API Token')
    } else {
      const started = await $.clock.now()
      try {
        judgment = await judge($, creds, model, action, context)
        ms = (await $.clock.now()) - started
      } catch (error) {
        $.ui.status(`Clef 未判斷：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const call = decide(verdict.decision, judgment, rule, { threshold, autoApprove })
    if (call.kind === 'pass') {
      if (judgment) $.ui.status(statusOf(action.tool, judgment, ms))
      return verdict
    }
    if (call.kind === 'approve') {
      $.ui.status(statusOf(action.tool, judgment, ms, 'approved'))
      return { decision: 'allow', reason: 'clef-guard：Clef 判斷這是唯讀動作，自動放行。' }
    }

    // Asked here rather than answered with `ask`: an ask goes to the mode's
    // decider, which under auto mode is a classifier, not the person.
    $.ui.status(statusOf(action.tool, judgment, ms, 'asking', rule))
    let answer: string
    try {
      answer = await $.ui.ask(questionOf(call.reasons, shownOf(action, context)), { header: 'clef-guard', options: [APPROVE, REFUSE] })
    } catch {
      $.ui.status(statusOf(action.tool, judgment, ms, 'refused', rule))
      return { decision: 'deny', reason: UNANSWERED }
    }
    const decided = verdictOf(answer)
    $.ui.status(statusOf(action.tool, judgment, ms, decided.decision === 'allow' ? 'allowed' : 'refused', rule))
    return decided
  }).catch(($, e, next) => {
    // A rule still holds when the hook fails: refuse rather than run unasked.
    const action = actionOf(e.tool, e.input)
    if (action?.tool === 'Bash' && tools.includes('Bash') && mustAsk(action.command, prefixes)) return { decision: 'deny', reason: UNANSWERED }
    return next(e)
  })
}
