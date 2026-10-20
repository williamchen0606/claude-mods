import { redact } from './redact'
import { STEPS_OF_KIND, head, isRecord, placeOf, tail } from './verify'
import type { Step, Turn, Verdict, Where } from './verify'

/**
 * Clairic reads the turn as one text and extracts the facts behind each
 * question: which changes need a check, which checks ran after the last
 * change, the counts and failures their output reports, the claims no step
 * shows, the parts of the request left undone and a closing question. The
 * code weighs those into the same verdict Clef gives, with the extracted
 * text kept as evidence.
 */

/** How much of the turn goes to Clairic, in characters. One pass holds 8,192 tokens, fields included. */
const STATE_CHARS = 16_000
const REQUEST_CHARS = 1_500
const FINAL_CHARS = 1_500
const COMMAND_CHARS = 300
/** The end of each command's output after the last change: at most this, at least the floor. */
const OUTPUT_CHARS = 2_000
const OUTPUT_FLOOR = 300

type Command = Extract<Step, { kind: 'command' }>

/** The commands run after the last changed file, in order. */
export function commandsAfter(turn: Turn): Command[] {
  const last = turn.steps.findLastIndex(step => step.kind === 'change')
  return turn.steps.slice(last + 1).filter((step): step is Command => step.kind === 'command')
}

/**
 * The `state` sent to Clairic: the request, the steps up to the last change
 * (commands without their output), the commands after it with the end of
 * their output, and the final message, redacted and clipped to fit one pass.
 */
export function stateTextOf(turn: Turn, finalMessage: string, where: Where): string {
  const numbered = turn.steps.map((step, i) => ({ step, number: i + 1 }))
  const last = turn.steps.findLastIndex(step => step.kind === 'change')
  const latest = (kind: Step['kind']) => numbered.filter(({ step }) => step.kind === kind).slice(-STEPS_OF_KIND)
  const kept = [...latest('change'), ...latest('command')].sort((a, b) => a.number - b.number)
  const ran = (step: Command) => `ran: ${redact(head(step.command, COMMAND_CHARS))}${step.failed ? ' (failed)' : ''}`

  const before = kept
    .filter(({ number }) => number <= last + 1)
    .map(({ step, number }) => `[${number}] ${step.kind === 'change' ? `changed: ${placeOf(step.path, where.root, where.home)}` : ran(step)}`)
  const after = kept.filter(({ number }) => number > last + 1) as { step: Command; number: number }[]

  const parts = [
    `REQUEST:\n${redact(head(turn.request, REQUEST_CHARS))}`,
    `STEPS UP TO THE LAST CHANGED FILE:\n${before.join('\n') || '(none)'}`,
    '',
    `FINAL MESSAGE:\n${redact(head(finalMessage, FINAL_CHARS))}`,
  ]
  const room = STATE_CHARS - parts.join('\n\n').length - after.reduce((sum, { step }) => sum + ran(step).length + 40, 0)
  const each = Math.max(OUTPUT_FLOOR, Math.min(OUTPUT_CHARS, Math.floor(room / Math.max(1, after.length))))
  parts[2] = `COMMANDS RUN AFTER THE LAST CHANGED FILE:\n${
    after.map(({ step, number }) => `[${number}] ${ran(step)}\noutput (end):\n${redact(tail(step.output, each)) || '(none)'}`).join('\n\n') || '(none)'
  }`
  return parts.join('\n\n')
}

/** The fields each request asks for, by id. */
const F = {
  codeChanges: 'code_changes',
  checks: 'check_commands',
  passedCounts: 'passed_counts',
  failedCounts: 'failed_counts',
  failures: 'failures',
  unsupported: 'unsupported_claims',
  undone: 'undone_parts',
  question: 'question',
} as const

/** The request body asking Clairic for the facts of the turn. */
export function clairicBody(turn: Turn, finalMessage: string, where: Where): string {
  const list = (items: 'text' | 'number', instructions: string) => ({ type: 'list', items, instructions })
  return JSON.stringify({
    model: 'clairic',
    state: stateTextOf(turn, finalMessage, where),
    fields: {
      [F.codeChanges]: list(
        'text',
        'Changed files that are code, tests, or build or CI configuration, which need a test, build or type-check to confirm they work. Leave out documentation, comments, prose and notes.',
      ),
      [F.checks]: list('text', 'Commands run after the last changed file that test, build, lint or type-check the changes.'),
      [F.passedCounts]: list('number', "Numbers of passed tests or checks that the output after the last changed file reports, one per summary (e.g. '120 passed' gives 120)."),
      [F.failedCounts]: list(
        'number',
        "Numbers of failed tests or errors that the output after the last changed file reports, one per summary (e.g. '3 failed' gives 3, 'Found 2 errors' gives 2).",
      ),
      [F.failures]: list('text', 'Names of failing tests, or error messages, in the output of the commands run after the last changed file.'),
      [F.unsupported]: list(
        'text',
        'Sentences in FINAL MESSAGE that claim a result, such as tests passing, a bug fixed or something working, that no step shows.',
      ),
      [F.undone]: list('text', 'Parts of REQUEST that no step carried out and that FINAL MESSAGE does not say were skipped, or why.'),
      [F.question]: {
        type: 'text',
        instructions: 'The question at the end of FINAL MESSAGE that asks the developer something, or for a decision, before going on.',
      },
    },
  })
}

type List<T> = { values: T[]; confidence: number }

function listOf<T>(answer: unknown, is: (value: unknown) => value is T): List<T> | undefined {
  if (!isRecord(answer) || !Array.isArray(answer.value) || typeof answer.confidence !== 'number') return undefined
  return { values: answer.value.filter(is), confidence: answer.confidence }
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** How likely the list holds something: its confidence when it does, the rest when it is empty. */
function present(list: List<unknown> | undefined): number | undefined {
  if (!list) return undefined
  return list.values.length ? list.confidence : 1 - list.confidence
}

function sum(list: List<number> | undefined): number {
  return list ? list.values.reduce((total, n) => total + n, 0) : 0
}

/** Whether `command` is the one Clairic quoted: one holds the other, as a span may cut either end. */
function quotes(command: string, quoted: string): boolean {
  const a = command.trim()
  const b = quoted.trim()
  return a.includes(b) || b.includes(a)
}

/**
 * Weighs Clairic's answers, from a Workers AI response body enveloped or
 * bare, into a verdict. A turn with no command after its last change was not
 * checked, whatever Clairic says; a check that exited with an error failed.
 * Undefined when the body holds no usable answer.
 */
export function parseClairic(text: string, turn: Turn): Verdict | undefined {
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

  const codeChanges = listOf(answers[F.codeChanges], isText)
  const checks = listOf(answers[F.checks], isText)
  const passedCounts = listOf(answers[F.passedCounts], isCount)
  const failedCounts = listOf(answers[F.failedCounts], isCount)
  const failures = listOf(answers[F.failures], isText)
  const unsupported = listOf(answers[F.unsupported], isText)
  const undone = listOf(answers[F.undone], isText)
  const question = answers[F.question]

  const verdict: Verdict = {}
  const evidence: NonNullable<Verdict['evidence']> = {}

  const needsCheck = present(codeChanges)
  if (needsCheck !== undefined) verdict.needsCheck = needsCheck

  const after = commandsAfter(turn)
  const checked = after.length ? present(checks) : 0
  if (checked !== undefined) verdict.checked = checked

  const failed = sum(failedCounts)
  const errored = after.filter(step => step.failed && checks?.values.some(quoted => quotes(step.command, quoted)))
  const failing = [
    errored.length ? 1 : undefined,
    present(failures),
    failedCounts && (failed > 0 ? failedCounts.confidence : 1 - failedCounts.confidence),
  ].filter((p): p is number => p !== undefined)
  if (failing.length) verdict.passed = 1 - Math.max(...failing)
  const failingEvidence = [...(failed > 0 ? [`失敗 ${failed} 個`] : []), ...(failures?.values ?? []), ...errored.map(step => `${step.command}（結束時回報錯誤）`)]
  if (failingEvidence.length) evidence.failing = failingEvidence
  if (passedCounts?.values.length || failedCounts?.values.length) verdict.tests = { passed: sum(passedCounts), failed }

  const claims = present(unsupported)
  if (claims !== undefined) verdict.claimsOk = 1 - claims
  if (unsupported?.values.length) evidence.unsupported = unsupported.values

  const unfinished = present(undone)
  if (unfinished !== undefined) verdict.unfinished = unfinished
  if (undone?.values.length) evidence.unfinished = undone.values

  if (isRecord(question) && typeof question.p_null === 'number') verdict.asksUser = 1 - question.p_null

  if (!Object.keys(verdict).length) return undefined
  if (Object.keys(evidence).length) verdict.evidence = evidence
  return verdict
}
