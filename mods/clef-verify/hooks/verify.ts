import type { SessionMessage } from 'claude-code'

import { redact } from './redact'

/** The Clef models on Workers AI; all take the same request and answer in the same shape. */
export const MODELS = ['clef', 'clef-flash', 'clef-omni'] as const
export type ClefModel = (typeof MODELS)[number]

/** The model named in the settings, or `clef` when it names none of `MODELS`. */
export function modelOf(value: unknown): ClefModel {
  return MODELS.find(model => model === value) ?? 'clef'
}

/** One thing Claude did during the turn: changed a file, or ran a command. */
export type Step = { kind: 'change'; path: string } | { kind: 'command'; command: string; failed: boolean; output: string }

/** The turn being checked: the person's prompt and Claude's steps since, in order. */
export type Turn = { request: string; steps: Step[] }

/** The tools that change files, with the input field holding the path. */
const CHANGERS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', NotebookEdit: 'notebook_path' }

/** A message the person typed, as opposed to one carrying tool results. */
function isPrompt(message: SessionMessage): boolean {
  return message.role === 'user' && !message.toolResults?.length && message.text.trim() !== ''
}

/**
 * The turn since the person's latest prompt, from the transcript. A
 * send-back is no message of its own, so the turn runs on across it.
 * Undefined when the transcript holds no prompt.
 */
export function turnOf(messages: SessionMessage[]): Turn | undefined {
  let start = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isPrompt(messages[i]!)) {
      start = i
      break
    }
  }
  if (start < 0) return undefined

  const steps: Step[] = []
  for (const message of messages.slice(start + 1)) {
    if (message.role !== 'assistant') continue
    for (const use of message.toolUses) {
      const field = CHANGERS[use.tool]
      if (field) {
        const path = use.input[field]
        if (typeof path === 'string' && !use.isError) steps.push({ kind: 'change', path })
      } else if (use.tool === 'Bash' && typeof use.input.command === 'string') {
        steps.push({ kind: 'command', command: use.input.command, failed: use.isError === true, output: use.text ?? '' })
      }
    }
  }
  return { request: messages[start]!.text.trim(), steps }
}

/** Whether the turn changed any file through the file tools. */
export function changedFiles(turn: Turn): boolean {
  return turn.steps.some(step => step.kind === 'change')
}

/** How much of each part goes to Clef. */
const REQUEST_CHARS = 1_500
const FINAL_CHARS = 1_500
const COMMAND_CHARS = 300
const OUTPUT_CHARS = 600
/** How many steps of each kind go to Clef: the latest ones. */
const STEPS_OF_KIND = 20

function head(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text
}

function tail(text: string, chars: number): string {
  return text.length > chars ? `…${text.slice(-chars)}` : text
}

/** `path` relative to the project when it lies in it, else under `~`, else as given. */
export function placeOf(path: string, root?: string, home?: string): string {
  for (const [dir, prefix] of [
    [root, '.'],
    [home, '~'],
  ] as const) {
    if (!dir) continue
    const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
    if (path.startsWith(`${base}/`)) return `${prefix}/${path.slice(base.length + 1)}`
  }
  return path
}

export type Where = { root?: string; home?: string }

/**
 * The `state` sent to Clef: the request, the latest steps of each kind in
 * their order (numbered as they happened), and Claude's final message, all
 * redacted and clipped.
 */
export function stateOf(turn: Turn, finalMessage: string, where: Where): Record<string, unknown> {
  const numbered = turn.steps.map((step, i) => ({ step, number: i + 1 }))
  const latest = (kind: Step['kind']) => numbered.filter(({ step }) => step.kind === kind).slice(-STEPS_OF_KIND)
  const kept = [...latest('change'), ...latest('command')].sort((a, b) => a.number - b.number)
  return {
    request: redact(head(turn.request, REQUEST_CHARS)),
    steps: kept.map(({ step, number }) =>
      step.kind === 'change'
        ? { step: number, changed: placeOf(step.path, where.root, where.home) }
        : { step: number, ran: redact(head(step.command, COMMAND_CHARS)), failed: step.failed, output_tail: redact(tail(step.output, OUTPUT_CHARS)) },
    ),
    final_message: redact(head(finalMessage, FINAL_CHARS)),
  }
}

/** The questions each request asks, by id. */
const Q = {
  needsCheck: 'needs_check',
  checked: 'checked',
  passed: 'passed',
  claimsOk: 'claims_ok',
  unfinished: 'unfinished',
  asksUser: 'asks_user',
} as const

const CONTEXT =
  'A coding agent is about to end its turn. `request` is what the developer asked for, `steps` are what the agent did since, in order (`changed` is a file it changed; `ran` is a shell command, with `failed` and the end of its output), and `final_message` is its reply.'

/** The Workers AI endpoint for `model` on `accountId`. */
export function endpoint(accountId: string, model: ClefModel): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${model}`
}

/** The request body asking Clef whether the turn's work is shown to be done. */
export function requestBody(model: ClefModel, turn: Turn, finalMessage: string, where: Where): string {
  const noul = (instructions: string) => ({ type: 'noul', instructions: `${CONTEXT} ${instructions}` })
  return JSON.stringify({
    model,
    state: stateOf(turn, finalMessage, where),
    questions: {
      [Q.needsCheck]: noul(
        'Do the changed files need a test, build, type-check or other run to confirm they work? Code and build or CI configuration usually do; documentation, comments, prose and notes usually do not.',
      ),
      [Q.checked]: noul('After the last changed file, did the agent run a test, build, lint or type-check that covers the changes?'),
      [Q.passed]: noul('Did the checks the agent ran after the last changed file pass?'),
      [Q.claimsOk]: noul(
        'Does the final message claim only what the steps show? Saying tests pass, a bug is fixed or something works, with no step that shows it, is a claim the steps do not show.',
      ),
      [Q.unfinished]: noul('Is part of the request left undone, with the final message not saying so or why?'),
      [Q.asksUser]: noul('Does the final message end by asking the developer a question or for a decision before going on?'),
    },
  })
}

/** What Clef said about the turn; each answer is absent when Clef gave none. */
export type Verdict = {
  needsCheck?: number
  checked?: number
  passed?: number
  claimsOk?: number
  unfinished?: number
  asksUser?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads Clef's answers from a Workers AI response body, enveloped
 * (`{ success, result: { answers } }`) or bare (`{ answers }`). Undefined
 * when it holds no usable answer at all.
 */
export function parseVerdict(text: string): Verdict | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(body)) return undefined
  const output = isRecord(body.result) ? body.result : body
  if (!isRecord(output.answers)) return undefined
  const answers = output.answers
  const verdict: Verdict = {}
  for (const [key, id] of Object.entries(Q) as [keyof Verdict, string][]) {
    const answer = answers[id]
    if (isRecord(answer) && typeof answer.noul === 'number' && answer.noul >= 0 && answer.noul <= 1) verdict[key] = answer.noul
  }
  return Object.keys(verdict).length ? verdict : undefined
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

/** What is missing, as Claude reads it, by finding. */
export const MISSING = {
  unchecked: '你改了檔案，但改完之後沒有跑測試、建置或其他檢查。請跑能驗證這些修改的檢查，確認通過後再回報。',
  failing: '改完之後跑的檢查沒有通過。請修正；如果失敗和這次修改無關，請說明原因。',
  unsupported: '你的最後回覆提到了步驟裡看不到依據的結果（例如測試通過、問題已修好）。請先實際驗證，或修改回覆，讓它和實際做過的事一致。',
  unfinished: '使用者的要求似乎還有沒完成的部分。請對照要求檢查；如果是刻意不做，請在回覆中說明原因。',
} as const
export type Finding = keyof typeof MISSING

/**
 * What the verdict finds missing, each when Clef is at least `threshold`
 * sure of it. The check findings count only for changes that need one, and
 * nothing is missing while the agent waits on the person's answer.
 */
export function findingsOf(verdict: Verdict, threshold: number): Finding[] {
  if ((verdict.asksUser ?? 0) >= 0.5) return []
  const findings: Finding[] = []
  const sure = (p: number | undefined) => p !== undefined && p >= threshold
  const not = (p: number | undefined) => (p === undefined ? undefined : 1 - p)
  if ((verdict.needsCheck ?? 0) >= 0.5) {
    if (sure(not(verdict.checked))) findings.push('unchecked')
    else if ((verdict.checked ?? 0) >= 0.5 && sure(not(verdict.passed))) findings.push('failing')
  }
  if (sure(not(verdict.claimsOk))) findings.push('unsupported')
  if (sure(verdict.unfinished)) findings.push('unfinished')
  return findings
}

/** The block reason Claude reads when it is sent back. */
export function blockOf(findings: Finding[]): string {
  return `clef-verify：結束前請先處理：\n${findings.map(finding => `· ${MISSING[finding]}`).join('\n')}\n如果確定不需要，請在回覆中說明原因再結束。`
}

/** Short names for the status line. */
const FINDING_LABELS: Record<Finding, string> = { unchecked: '沒跑檢查', failing: '檢查沒過', unsupported: '回覆沒有依據', unfinished: '要求沒做完' }

export type Outcome = { kind: 'passed' } | { kind: 'sent-back'; count: number; max: number } | { kind: 'gave-up'; max: number }

/** The status line text; the engine shows it after the mod's name. */
export function statusOf(verdict: Verdict, findings: Finding[], ms: number, outcome: Outcome): string {
  const parts: string[] = []
  if (verdict.needsCheck !== undefined) parts.push(`需要檢查 ${percent(verdict.needsCheck)}`)
  if (findings.length) parts.push(findings.map(finding => FINDING_LABELS[finding]).join('、'))
  parts.push(`${Math.round(ms)}ms`)
  if (outcome.kind === 'passed') parts.push('通過')
  if (outcome.kind === 'sent-back') parts.push(`退回 ${outcome.count}/${outcome.max}`)
  if (outcome.kind === 'gave-up') parts.push(`已退回 ${outcome.max} 次，不再退回`)
  return parts.join(' · ')
}

/** The toast when Claude ends anyway after the last send-back. */
export function gaveUpToast(findings: Finding[]): string {
  return `clef-verify：Claude 結束了，但 Clef 仍判斷${findings.map(finding => FINDING_LABELS[finding]).join('、')}，請自己確認一下。`
}
