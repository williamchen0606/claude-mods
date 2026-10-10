/** The Clef models on Workers AI; all take the same request and answer in the same shape. */
export const MODELS = ['clef', 'clef-flash', 'clef-omni'] as const
export type ClefModel = (typeof MODELS)[number]

/** The model named in the settings, or `clef` when it names none of `MODELS`. */
export function modelOf(value: unknown): ClefModel {
  return MODELS.find(model => model === value) ?? 'clef'
}

/** The permission verdict a `tool.check` hook reads and answers. */
export type Decision = 'allow' | 'ask' | 'deny'

/** What Clef said about one command. */
export type Risk = {
  /** Probability the command is at `RISKY_FROM` or above. */
  risky: number
  /** The most likely level, an index into `LEVELS`. */
  level: number
}

/** The id of the one question each request asks. */
const QUESTION = 'risk'

/** The rubric Clef rates a command on, lowest first. */
export const LEVELS = [
  'Read-only or harmless: lists, reads, searches, prints, builds or runs tests without changing anything outside build output.',
  'Changes files inside the current project in ways that are easy to undo (edits, git add, git commit, local installs).',
  'Changes state outside the project or over the network, but recoverably (global installs, starting services, creating cloud resources, git push to a feature branch).',
  'Hard to undo: deletes data, rewrites or force-pushes git history, pushes to a main branch, changes permissions or ownership, drops database tables, edits system configuration.',
  'Destructive or dangerous: deletes broadly (rm -rf on home, root or wildcards), wipes disks, pipes remote scripts into a shell, disables security, or sends secrets or files to an outside host.',
]

/** The short names the status line and the dialog use for each level. */
export const LEVEL_LABELS = ['無害', '專案內修改', '對外變更', '難以復原', '破壞性']

/** The first level that counts as risky. */
export const RISKY_FROM = 3

const MASK = '<redacted>'

const SECRET_PATTERNS: [RegExp, string][] = [
  // Authorization headers and bearer tokens.
  [/(authorization:\s*(?:bearer|basic|token)?\s*)[^\s'"]+/gi, `$1${MASK}`],
  [/(bearer\s+)[^\s'"]+/gi, `$1${MASK}`],
  // NAME=value where the name says it holds a secret.
  [/(\b[\w.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?[\w.-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s'"]+)/gi, `$1${MASK}`],
  // --password value, --token=value, ...
  [/(--?(?:password|passwd|pass|token|secret|api-?key|auth|key)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s'"-][^\s'"]*)/gi, `$1${MASK}`],
  // user:password@ in URLs.
  [/(\w+:\/\/)[^\s/@'"]+@/g, `$1${MASK}@`],
  // Well-known token formats.
  [/\b(?:sk|pk|rk)-[\w-]{16,}/g, MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_\w{20,}/g, MASK],
  [/\bxox[abprs]-[\w-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
]

/** Long opaque runs of letters and digits, which are usually keys. */
const OPAQUE = /[A-Za-z0-9+/_=-]{40,}/g

/**
 * Masks what looks like a credential in a command before it leaves the
 * machine. A heuristic: it errs on masking, since Clef needs the shape of the
 * command, not its secrets.
 */
export function redact(command: string): string {
  let out = command
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out.replace(OPAQUE, run => (/[A-Za-z]/.test(run) && /[0-9]/.test(run) ? MASK : run))
}

/** The Workers AI endpoint for `model` on `accountId`. */
export function endpoint(accountId: string, model: ClefModel): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${model}`
}

/** The request body asking Clef how risky `command` is; the command is redacted here. */
export function requestBody(model: ClefModel, command: string): string {
  return JSON.stringify({
    model,
    state: { tool: 'Bash', command: redact(command) },
    questions: {
      [QUESTION]: {
        type: 'score',
        instructions:
          'A coding agent is about to run this shell command on a developer machine. How risky is it to run without asking the developer first?',
        criteria: LEVELS,
      },
    },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the risk from a Workers AI response body, enveloped
 * (`{ success, result: { answers } }`) or bare (`{ answers }`).
 * Undefined when the body holds no usable answer.
 */
export function parseRisk(text: string): Risk | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(body)) return undefined
  const output = isRecord(body.result) ? body.result : body
  const answer = isRecord(output.answers) ? output.answers[QUESTION] : undefined
  if (!isRecord(answer) || !isRecord(answer.probabilities)) return undefined

  let risky = 0
  let level = -1
  let best = -1
  for (const [key, value] of Object.entries(answer.probabilities)) {
    const index = Number(key)
    if (typeof value !== 'number' || !Number.isInteger(index) || index < 0 || index >= LEVELS.length) continue
    if (index >= RISKY_FROM) risky += value
    if (value > best) {
      best = value
      level = index
    }
  }
  if (level < 0) return undefined
  return { risky: Math.min(1, risky), level }
}

/** The error message from a failed Workers AI response, if it carries one. */
export function errorOf(status: number, text: string): string {
  try {
    const body: unknown = JSON.parse(text)
    if (isRecord(body) && Array.isArray(body.errors)) {
      const first: unknown = body.errors[0]
      if (isRecord(first) && typeof first.message === 'string') return `HTTP ${status}: ${first.message}`
    }
  } catch {}
  return `HTTP ${status}`
}

export function percent(p: number): string {
  return `${Math.round(p * 100)}%`
}

/** The option that lets the command run; anything else refuses it. */
export const APPROVE = '執行'
export const REFUSE = '不要執行'

/** How much of the command the question shows. */
const SHOWN_CHARS = 300

/** The question clef-guard asks before a risky command runs. */
export function questionOf(risk: Risk, command: string): string {
  const shown = command.length > SHOWN_CHARS ? `${command.slice(0, SHOWN_CHARS)}…` : command
  return `Clef 判斷這條指令有 ${percent(risk.risky)} 的機率難以復原或具破壞性（最可能：${LEVEL_LABELS[risk.level]}）：\n\n${shown}\n\n要執行嗎？`
}

/**
 * The verdict from the person's answer: only an exact `APPROVE` runs the
 * command. Text typed under "Other" goes back to the model as the reason, so
 * it can change course; an empty or timed-out answer is a refusal.
 */
export function verdictOf(answer: string): { decision: 'allow' | 'deny'; reason: string } {
  if (answer === APPROVE) return { decision: 'allow', reason: 'clef-guard：使用者確認後執行。' }
  const said = answer.trim()
  return said && said !== REFUSE
    ? { decision: 'deny', reason: `clef-guard：使用者拒絕執行這條指令，並回覆：${said}` }
    : { decision: 'deny', reason: 'clef-guard：使用者拒絕執行這條指令。' }
}

/** Why the command was refused when nobody could be asked. */
export const UNANSWERED = 'clef-guard：Clef 判斷這條指令有風險，但無法詢問使用者（對話框被關閉，或在非互動模式下執行），所以沒有執行。'

/** The status line text for a judged command; the engine shows it after the mod's name. */
export function statusOf(risk: Risk, ms: number, outcome?: 'asking' | 'allowed' | 'refused'): string {
  const tail = outcome === 'asking' ? ' · 等你確認' : outcome === 'allowed' ? ' · 你已確認' : outcome === 'refused' ? ' · 已拒絕' : ''
  return `Clef 風險 ${percent(risk.risky)} · ${LEVEL_LABELS[risk.level]} · ${Math.round(ms)}ms${tail}`
}

/** True when the person should be asked: a risk at or above `threshold` on a call the engine did not already refuse. */
export function needsConfirm(core: Decision, risk: Risk, threshold: number): boolean {
  return core !== 'deny' && risk.risky >= threshold
}
