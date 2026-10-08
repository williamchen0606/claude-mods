/** The Clef models on Workers AI; both take the same request. */
export type ClefModel = 'clef' | 'clef-flash'

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

/** What the permission dialog shows when Clef asks for a command. */
export function reasonOf(risk: Risk): string {
  return `clef-guard：Clef 判斷這條指令有 ${percent(risk.risky)} 的機率難以復原或具破壞性（最可能：${LEVEL_LABELS[risk.level]}），請確認後再執行。`
}

/** The status line text for a judged command. */
export function statusOf(risk: Risk, ms: number, asked: boolean): string {
  return `Clef ${asked ? '⚠ ' : ''}風險 ${percent(risk.risky)} · ${LEVEL_LABELS[risk.level]} · ${Math.round(ms)}ms`
}

/**
 * The verdict after Clef: only ever tightened. A deny stays a deny, an allow
 * becomes an ask at or above `threshold`, and an ask gains Clef's reason
 * there. Undefined when the engine's verdict should stand as it is.
 */
export function tighten(core: Decision, risk: Risk, threshold: number): { decision: 'ask'; reason: string } | undefined {
  if (core === 'deny' || risk.risky < threshold) return undefined
  return { decision: 'ask', reason: reasonOf(risk) }
}
