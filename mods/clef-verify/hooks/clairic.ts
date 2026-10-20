import { redact } from './redact'
import { STEPS_OF_KIND, isRecord, tail, head } from './verify'
import type { Step, Turn, Verdict } from './verify'

/**
 * The first stage: Clairic reads the output of the commands run after the
 * last change and extracts the facts in it (which commands are checks, the
 * pass and fail counts their output reports, the failures it names). The
 * code sums the counts and hands the facts to Clef, which decides; Clairic
 * decides nothing.
 */

/** How much goes to Clairic, in characters. One pass holds 8,192 tokens, fields included. */
const STATE_CHARS = 16_000
const COMMAND_CHARS = 300
/** The end of each command's output: at most this, at least the floor. */
const OUTPUT_CHARS = 2_000
const OUTPUT_FLOOR = 300
/** Below this confidence an extracted list is left out of what Clef reads. */
const SURE = 0.5

type Command = Extract<Step, { kind: 'command' }>

/** The commands run after the last changed file, in order, the latest `STEPS_OF_KIND` of them. */
export function commandsAfter(turn: Turn): Command[] {
  const last = turn.steps.findLastIndex(step => step.kind === 'change')
  return turn.steps
    .slice(last + 1)
    .filter((step): step is Command => step.kind === 'command')
    .slice(-STEPS_OF_KIND)
}

/** The `state` sent to Clairic: each command after the last change with the end of its output, redacted and clipped to fit one pass. */
export function stateTextOf(commands: Command[]): string {
  const ran = (step: Command) => `$ ${redact(head(step.command, COMMAND_CHARS))}${step.failed ? '  (exited with an error)' : ''}`
  const room = STATE_CHARS - commands.reduce((sum, step) => sum + ran(step).length + 20, 0)
  const each = Math.max(OUTPUT_FLOOR, Math.min(OUTPUT_CHARS, Math.floor(room / Math.max(1, commands.length))))
  return commands.map(step => `${ran(step)}\n${redact(tail(step.output, each)) || '(no output)'}`).join('\n\n')
}

/** The fields each request asks for, by id. */
const F = { checks: 'check_commands', passed: 'passed_counts', failed: 'failed_counts', failures: 'failures' } as const

/** The request body asking Clairic for the facts in the output of `commands`. */
export function clairicBody(commands: Command[]): string {
  const list = (items: 'text' | 'number', instructions: string) => ({ type: 'list', items, instructions })
  return JSON.stringify({
    model: 'clairic',
    state: stateTextOf(commands),
    fields: {
      [F.checks]: list('text', 'Commands (the lines starting with $) that run tests, a build, a linter or a type-check.'),
      [F.passed]: list('number', "Numbers of passed tests or checks that the output reports, one per summary (e.g. '120 passed' gives 120)."),
      [F.failed]: list('number', "Numbers of failed tests or errors that the output reports, one per summary (e.g. '3 failed' gives 3, 'Found 2 errors' gives 2)."),
      [F.failures]: list('text', 'Names of failing tests, or error messages, in the output.'),
    },
  })
}

/** What Clairic read in the output; each part is absent when it was not sure of it. */
export type Facts = {
  checks?: string[]
  passed?: number
  failed?: number
  failures?: string[]
  /** The checks among the commands that exited with an error. */
  errored: string[]
}

function listOf<T>(answer: unknown, is: (value: unknown) => value is T): T[] | undefined {
  if (!isRecord(answer) || !Array.isArray(answer.value) || typeof answer.confidence !== 'number' || answer.confidence < SURE) return undefined
  return answer.value.filter(is)
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Whether `command` is the one Clairic quoted: one holds the other, as a span may cut either end. */
function quotes(command: string, quoted: string): boolean {
  const a = command.trim()
  const b = quoted.trim()
  return a.includes(b) || b.includes(a)
}

/**
 * Reads the facts from a Workers AI response body, enveloped or bare,
 * summing the counts. Undefined when the body holds no usable answer.
 */
export function parseFacts(text: string, commands: Command[]): Facts | undefined {
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

  const checks = listOf(answers[F.checks], isText)
  const passed = listOf(answers[F.passed], isCount)
  const failed = listOf(answers[F.failed], isCount)
  const failures = listOf(answers[F.failures], isText)
  if (!checks && !passed && !failed && !failures) return undefined

  const sum = (counts: number[] | undefined) => counts?.reduce((total, n) => total + n, 0)
  const facts: Facts = {
    errored: commands.filter(step => step.failed && checks?.some(quoted => quotes(step.command, quoted))).map(step => redact(head(step.command, COMMAND_CHARS))),
  }
  if (checks) facts.checks = checks
  if (passed?.length) facts.passed = sum(passed)
  if (failed?.length) facts.failed = sum(failed)
  if (failures) facts.failures = failures
  return facts
}

/** The facts as Clef reads them, under `extracted` in its state. */
export function extractedOf(facts: Facts): Record<string, unknown> {
  return {
    ...(facts.checks ? { check_commands: facts.checks } : {}),
    ...(facts.passed !== undefined ? { tests_passed: facts.passed } : {}),
    ...(facts.failed !== undefined ? { tests_failed: facts.failed } : {}),
    ...(facts.failures ? { failures: facts.failures } : {}),
    ...(facts.errored.length ? { checks_that_exited_with_an_error: facts.errored } : {}),
  }
}

/** The evidence behind a finding the facts bear on, and the test counts, for the block and the status line. */
export function evidenceOf(facts: Facts): Pick<Verdict, 'evidence' | 'tests'> {
  const failing = [
    ...(facts.failed ? [`失敗 ${facts.failed} 個`] : []),
    ...(facts.failures ?? []),
    ...facts.errored.map(command => `${command}（結束時回報錯誤）`),
  ]
  return {
    ...(failing.length ? { evidence: { failing } } : {}),
    ...(facts.passed !== undefined || facts.failed !== undefined ? { tests: { passed: facts.passed ?? 0, failed: facts.failed ?? 0 } } : {}),
  }
}
