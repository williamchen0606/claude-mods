---
name: spec
description: Write or revise a structured specification before building (spec-driven development). Use it when starting a feature, a non-trivial bug fix, a refactor or a spike, when the user says "spec", "write the spec first", "requirements", "acceptance criteria", "PRD", "design doc" or "what should this do", and whenever /devflow:go reaches its spec stage. The spec is a short, numbered contract that the tests and the plan cite, not a long document; for small tasks it is three lines in the reply. Do not use it to document code that already exists unchanged.
argument-hint: <the change to specify, or the path of a spec to revise>
---

# spec: agree on behaviour before code

A spec here is the single durable document for one piece of work. It states the intent, draws the boundary, and lists the behaviour as numbered scenarios that tests will cite by number. The plan, the evidence and the decisions are appended to the same file as the work progresses, so the file tells the whole story and a reader with none of this conversation can pick the work up.

Write it for that reader. Everything they need to implement and verify the change goes in the file. Conversation is where you discover the spec; the file is where it lives.

The spec is also deliberately short. "The best spec is code" is true of design: do not write paragraphs about how the code will be organised, write the code and let the tests pin it. What a spec adds is the agreement on *what the code must do*, written before the code exists, at the granularity of a test. If a section does not change what a test asserts or what a reviewer accepts, cut it.

## Pick the level

| Level | When | Where |
| --- | --- | --- |
| **brief** | size S: a few lines, behaviour obvious | in the reply, three to five lines: intent, non-goal, scenarios |
| **standard** | size M | `docs/specs/<yyyy-mm-dd>-<slug>.md`, or the repo's own place for specs |
| **full** | size L, or anything with contested design, migrations, security or concurrency | same place; adds design, risks and rollout |

If the repo already keeps specs, RFCs or ADRs somewhere (`specs/`, `docs/rfcs/`, `docs/adr/`, `.specify/`), use that place and its naming. Match the surroundings rather than introducing a second convention.

## Before writing: attack the premise

Spend one minute on these before the template, because they change what the spec says:

1. **What is the user actually trying to achieve?** The request names a solution; write down the outcome behind it. If the outcome is reachable by deleting or configuring something, say so and propose that instead.
2. **What already exists?** Read the code the change touches. A spec that ignores an existing abstraction gets implemented twice.
3. **What is explicitly not changing?** Non-goals keep the diff reviewable and are the first thing a reviewer looks for.

## The structure

`references/template.md` has the full template with field-by-field guidance. The sections, in order, and why each exists:

1. **Frontmatter**: `status` (draft → agreed → building → done → superseded), `track`, `size`, date. Status tells a reader whether the file is a proposal or a record.
2. **Intent**: one paragraph. The problem and the outcome, not the solution. If you cannot write it in one paragraph, the task is two tasks.
3. **Scope and non-goals**: bullets. What this change covers and, more importantly, what it deliberately does not.
4. **Behaviour**: numbered scenarios `S1`, `S2`, ... in Given / When / Then form, each one observable behaviour. These become tests one for one, so write them at the granularity of a test: one trigger, one observable result. Include the error and edge scenarios, because those are the ones nobody writes tests for later.
5. **Interfaces and data**: signatures, shapes, commands, endpoints, file formats that the change introduces or alters, with error cases. This is the contract between slices and between agents working in parallel. Name the data shape before any logic: a state machine over scattered booleans, a table over branching.
6. **Invariants and constraints**: what must stay true across the change (idempotency, ordering, limits, compatibility, performance budgets). Each one is a candidate test or check.
7. **Open questions**: each with the assumption you will proceed under if unanswered. Never leave a question without an assumption, because the work must not stall on it.
8. **Decision log**: dated entries, decision, reason, alternatives rejected. Appended over time; never rewritten.
9. **Plan** and **Evidence**: left empty here; `plan` and `prove` fill them.

Full level adds **Design** (the chosen approach and the alternatives, as a table), **Risks** (what could go wrong and how you would notice) and **Rollout** (flags, migration order, how to back out).

## Writing the scenarios well

- One behaviour each. "S3: Given an empty file, when parsed, then returns an empty list and no error" is a test. "S3: handles edge cases" is not.
- Observable from outside: inputs, outputs, errors, side effects a caller can see. Not "uses a hash map".
- Cover the unhappy paths: invalid input, missing data, concurrency, limits. A spec with only happy scenarios ships bugs.
- Stable numbers: once a scenario has a number and a test cites it, do not renumber. Add `S9`, or mark `S4` as "removed, see decision log".
- Concrete values over adjectives: "within 200 ms", not "fast"; "returns 404", not "fails".

## Sort the open questions

Before asking anything, classify each question:

- **Observable**: the answer is a fact you could get by running something (does the API return X, how long does Y take, does the test separate). Not the user's to answer. Run the smallest experiment, write the result in the decision log, and move on.
- **Product or preference**: naming, which of two valid behaviours, what to do on a trade-off no experiment settles. Ask, with options and your recommendation, and record your assumption so the work can proceed meanwhile.

## Checkpoint with the user

For standard and full, summarise the spec in the reply (intent, scenario count, the open questions with your assumptions) and ask only the questions whose answers would change the work materially. If the user is away, proceed under the written assumptions; the spec records them, and `prove` reports which were never confirmed. Set `status: agreed` when the user confirms, or when you proceed on assumptions, with a decision-log line saying so.

## Exit condition

Intent, non-goals and numbered scenarios exist; every open question carries an assumption; interfaces are written where more than one slice or agent will touch them; the user has seen the summary (or the brief is in the reply). Then hand over to `plan` (M, L) or straight to `tdd` (S).

When this stage runs under `/devflow:go`, mark `spec` done and the next stage active in `.devflow/state.json` (see `go`), and put the spec file's path in its `spec` field.
