---
name: prove
description: Verify a change against its spec before calling it done, and write the evidence down. Use it after building, before any "done", "finished", "ready for review" or "tests pass" claim, when the user says "verify", "prove it", "did you test it", "are you sure", "show me", and whenever /devflow:go reaches its prove stage. It runs the repo's checks, walks every spec scenario with a command and a result, labels every claim as measured or inferred, and reads the diff adversarially. Do not skip it for small changes; it is short for small changes.
argument-hint: <path of the spec, or nothing for the brief in the reply>
---

# prove: evidence, not confidence

Work is done when someone else could believe it without taking your word. That means for every behaviour the spec promised there is a command you ran and a result you saw, the repo's own checks were run on the final state, and the diff was read by you as if you were the reviewer trying to reject it.

## 1. Run the repo's checks on the final state

Find what a contributor runs before pushing (CONTRIBUTING, AGENTS.md, CLAUDE.md, package scripts, Makefile, CI config) and run it: lint, format, typecheck, the test suite, build. Run it on the final tree, after the last edit; a green run from before a "tiny" follow-up edit is not evidence for the current state.

A check that was skipped, timed out, or ran on the wrong surface is not a pass. Say so and count it as missing. If a check cannot run here, name what would run it.

## 2. Walk the spec

One row per scenario and per invariant, in the spec's `## Evidence` section (or the reply, for a brief spec):

```
| Scenario | How proven | Command | Result | Label |
| S1 | tests/upload/retry.test.ts "S1 ..." | npm test -- retry | 1 passed | measured |
| S2 | same file, "S2 ..." | npm test -- retry | 1 passed | measured |
| S3 | manual: curl against dev server | curl -i ... | 404 in body | measured |
| I1 (idempotent) | not tested; follows from S1 using a pure function | — | — | inferred |
```

**Labels.** *Measured*: you ran it in this session and saw the result. *Inferred*: follows from something measured, and you say from what. *Guessed*: anything else; a guessed row is a gap, and the reply must call it one. Never hand the user a check you could have run yourself.

Then compare against the plan: every scenario present, every open question either answered or still carrying its assumption, every non-goal still untouched by the diff.

## 3. Read the diff as the reviewer

`git diff <base>...HEAD`, the whole thing, with one question: what would make me reject this?

- **Unrelated changes.** Formatting churn, renames the spec did not ask for, "while I'm here" edits. Remove them or move them to a follow-up.
- **Behaviour the spec did not ask for.** Extra options, speculative generality, defensive guards for states that cannot occur. Delete; subtract before you add.
- **Comments that narrate the obvious** or restate the code. Keep only a non-obvious *why*.
- **Tests that cannot fail.** Assertions on data the test built itself, expected values computed by the code under test, mocks asserting on mocks.
- **Dead code, leftover debug output, TODOs without an owner.**
- **The non-goals.** Did the diff cross one? If yes, revert that part or get the spec changed first.

For L work, or when the design was contested, also get a second reading from a fresh subagent (a different model if available) with the spec and the diff and the same question. Agreement between independent readers is high signal; disagreement is a finding to resolve, not to average.

## 4. Numbers

If the change claims a performance effect, report one primary number with its unit, before → after, measured the same way on both sides, and say what limits it. A number without a baseline, or measured on a different surface, is not a claim you can make.

## 5. Report

The reply names, in this order: what was proven (the table, or its summary with a link to the spec), what is missing or inferred and why, what the diff review removed, and the assumptions the user never confirmed. Short declarative sentences; every claim with its evidence or label in the same sentence.

The spec is proven when the table has no guessed rows and the checks are green. Who marks it `done` depends on what comes next, so the status never claims more than happened:

- If `ship` runs next, leave `status: building`; `ship` sets `done` once the change has landed.
- If the route ends here (a spike, or `ship` skipped because the user commits), set `status: done` now, with a decision-log line saying how the work is handed over.
- If anything is still guessed or red, it stays `building` and the reply says what is left.

## Exit condition

Repo checks green on the final tree; every scenario and invariant has an evidence row, labelled; the diff has been read adversarially and cleaned; the report is written. Then `ship`.

Under `/devflow:go`, mark `prove` done in `.devflow/state.json` when the table has no guessed rows, and `ship` active if it runs.
