---
name: diagnose
description: Reproduce a defect and find its root cause before any fix is written. Use it whenever something is reported broken, failing, crashing, regressed, slow or wrong, when the user pastes a stack trace or a failing test, says "bug", "debug", "why does this fail", "it used to work", and whenever /devflow:go routes to the bug track. Use it even when the cause looks obvious: the reproduction becomes the regression test and the evidence decides what ships. Do not use it to design new behaviour.
argument-hint: <the failure: symptom, error text, failing test or steps>
---

# diagnose: reproduce, then root-cause, then hand the fix a test

Be scientific. Every line of a fix should trace to runtime evidence, and a change that "might help" is a hypothesis, not a fix. The point of this stage is to replace guessing with observation, and to leave behind a reproduction that `tdd` can turn into the regression test.

## 1. Reproduce it yourself

Get the failure to happen on demand, on the surface where it was reported (the test runner, the CLI, the browser, the API). One command or script that fails is the goal.

- Start from what was given: the stack trace, the failing test, the steps. Run them.
- If it does not reproduce directly, tighten the conditions: the exact input, the exact version, the state before the trigger, timing. Synthesize the trigger if you must (a fixture, a fake clock, a forced error from a dependency).
- Ask the user to reproduce only when you have driven it as far as your tools reach and can say specifically what you cannot reach.
- Write the reproduction down as a command and its output. This is evidence and the seed of the test.

A "fix" for a bug you never saw fail is a guess with a commit message.

## 2. Narrow to the mechanism

Form the candidate causes, then rule them out with observations until one survives. Each pass, choose the observation that cuts the most remaining possibilities.

- Read the code path from the trigger to the symptom, including the history (`git log -p` on the files, the commit that last touched the failing line, what changed around the time it broke).
- Add instrumentation or logging where the state is unclear and read it as the code runs. Do not reason about what a variable "should" be when you can print it.
- Separate symptom from cause. Ask "why" until the answer is the first place the system went wrong, not the place where it became visible. A guard added where the symptom appears is a fix only when the state it handles is legitimate; otherwise it hides the cause.
- If two fixes sharing one assumption have already failed, write the assumption down and test it directly before trying a third.

State the mechanism in one sentence with its evidence: "`parse()` returns `undefined` for an empty file because the loop never runs and the result variable is only set inside it; measured by the log line at `parser.ts:42` on the repro."

## 3. Check the blast radius

Before fixing, look for the same mechanism elsewhere: sibling call sites, copies of the pattern, the same assumption in another module. Note them; the fix may need to cover them, or they go in the spec's open questions as follow-ups.

## 4. Hand over

Write the handover for `tdd` (and the spec, if the bug is M or L):

- The reproduction: command, expected, actual.
- The root cause, one sentence, with evidence.
- The intended behaviour as a scenario: "S1 Given <state>, when <trigger>, then <correct result>".
- The smallest fix the evidence justifies, and what it does not cover.

If the fix changes behaviour beyond restoring the intended one (a new interface, a changed contract), stop and route through `spec` so the change is agreed, not smuggled in with the fix.

## Exit condition

The failure reproduces on demand with one command or script; the root cause is named in one sentence with the evidence that points to it; the intended behaviour is written as a scenario for `tdd`. Then `tdd` writes the failing test from the reproduction, lands it, and puts the fix on top.
