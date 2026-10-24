---
name: tdd
description: Build one slice test-first (red, green, refactor), with each test citing the spec scenario it proves. Use it for every slice of a feature or refactor, for the regression test of a bug fix, when the user says "tdd", "test first", "write the failing test", "red green", "regression test", and whenever /devflow:go reaches its build stage. Use it even when the user did not say "test": a change without a failing test first is a change whose behaviour was never pinned. Skip only when no executable check is practical, and say so.
argument-hint: <the slice or scenario to build, e.g. "Slice 2" or "S3">
---

# tdd: red, green, refactor, per slice

Test-driven development is not about coverage. It is a way of making the spec executable before the implementation exists, so the implementation has something to be wrong against. With an agent writing the code, this matters more, not less: an agent that writes code first and tests second will write tests that pass, which proves nothing. An agent that writes the failing test first has pinned the behaviour independently of its own implementation.

Work one slice at a time (from the plan, or the single slice of an S task). For each scenario the slice covers:

## 1. Red: write the test that would catch the bug or prove the behaviour

- Name the test after the scenario and cite its number, so a reader can go from spec to test to code: `test('S2: retries twice on 503 then succeeds', ...)`, or the equivalent in the repo's framework.
- Drive the code through the interface its users use (a caller, a CLI, an endpoint), with a concrete input. Derive the expected value from the spec, never from running the code.
- Assert what the contract promises, no less and no more. Return values, errors a caller branches on, state a caller can read back, calls to external systems the caller cares about. Not private helpers, internal call order, or exact wording nobody reads.
- Use the narrowest existing test path for that code. Match the repo's framework, layout and naming; a test in the wrong place is a test nobody runs.

**Run it and read the failure.** It must fail for the intended reason: the behaviour is missing, not a typo, an import error or a bad fixture. If it passes, the scenario is already true (say so and move on), or the test is not testing what you think. If it fails for the wrong reason, fix the test before touching production code.

## 2. Green: the smallest change that makes it pass

Write the least production code that turns the test green, even if it looks naive. Then run the test again and the rest of the slice's tests with it. Resist generalising now: the next scenario's test will pull the design where it needs to go, and a first draft that does everything hides which part made it pass.

Do not change the test to match the code. If the test is wrong because the spec was wrong, change the spec first (decision log entry), then the test, then the code.

## 3. Refactor: with the tests as the net

Now improve the shape: remove duplication, name the data structure the code was circling around (a table instead of branches, a state machine instead of booleans), delete anything the scenarios did not need. Run the tests after each step. Judge each test against two imagined edits: break the behaviour and the test must fail; restructure the internals and the test must keep passing. A test that fails the second edit is pinned to the implementation; rewrite or delete it.

Commit when the slice is green, so the failing-test-then-fix sequence is visible in history and a reviewer can replay it.

## For a bug

The scenario is the bug's intended behaviour, and the first test is the reproduction from `diagnose` turned into a test. Order matters: the failing test lands first, the fix on top, so the history itself shows red then green. Keep the test narrow; sibling coverage for the same class of bug comes after the core regression path is in.

## When a failing test is impractical

Some behaviour has no cheap test path: a visual layout, a race that needs production load, a one-off migration. Do not force a test that mostly asserts on mocks, depends on timing, or needs heavy infrastructure for a small change. A bad test is worse than none because it will be deleted or ignored and leaves false confidence.

Instead use the closest executable check: a script that reproduces, a snapshot comparison, a log assertion, a browser or CLI drive, and keep its command and output as evidence. Say in the reply which scenarios have a test and which have a check, and why.

## Guardrails

- Never weaken an existing assertion to get green unless the spec changed and the decision log says so.
- Never skip, disable or quarantine a test to get green.
- Make a flaky reproduction deterministic (fake clock, fixed seed, controlled fixture) rather than retrying it.
- Keep the diff to the slice. "While I'm here" changes go in the spec's open questions or a follow-up, not this commit.

## Exit condition

Every scenario in the slice has a test (or a named check) that was seen failing for the intended reason and then seen passing; the slice's test command is green; the refactor left the tests green; the slice is committed. Record the commands and the before/after results; `prove` will cite them.
