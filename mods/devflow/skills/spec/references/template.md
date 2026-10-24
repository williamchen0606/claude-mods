# Spec template

Copy the sections you need. Guidance is in the HTML comments; delete them in the real file. Standard level uses everything except Design, Risks and Rollout.

````markdown
---
title: <short title, imperative: "Add retry to the uploader">
status: draft            # draft | agreed | building | done | superseded
track: feature           # feature | bug | refactor | spike | chore
size: M                  # S | M | L
date: 2026-10-24
supersedes:              # path of an earlier spec, if any
---

# <title>

## Intent

<!-- One paragraph. The problem, who has it, and the outcome once this lands.
     Not the solution. If you need two paragraphs, this is two pieces of work. -->

## Scope and non-goals

In scope:
- <what this change covers>

Non-goals:
- <what it deliberately does not do, and where that goes instead if anywhere>

## Behaviour

<!-- One scenario per observable behaviour. Numbers are stable: never renumber.
     Each becomes a test that cites its number. Cover errors and edges. -->

- **S1** Given <state>, when <trigger>, then <observable result>.
- **S2** Given <state>, when <trigger>, then <observable result>.
- **S3** Given <invalid or missing input>, when <trigger>, then <error a caller can see>.

## Interfaces and data

<!-- Signatures, data shapes, CLI flags, endpoints, file formats, events.
     Include error cases and types. This is the contract between slices and agents.
     Name the organising structure: state machine, table, typed model. -->

```ts
export function retry<T>(fn: () => Promise<T>, opts: { attempts: number; backoffMs: number }): Promise<T>
// rejects with the last error once attempts are exhausted
```

## Invariants and constraints

<!-- What stays true across the change. Each is a candidate test or check. -->

- <idempotency, ordering, limits, compatibility, budgets>

## Open questions

<!-- Each with the assumption you proceed under if unanswered.
     Observable questions get an experiment, not a question to the user. -->

- Q1 <question>. Assumption: <what you will do>.

## Decision log

<!-- Append-only. Date, decision, why, alternatives rejected. -->

- 2026-10-24 Chose <X> over <Y> because <reason>. Rejected <Z>: <reason>.

## Design            <!-- full level only -->

| Option | How it works | Pros | Cons |
| --- | --- | --- | --- |
| A (chosen) | | | |
| B | | | |

## Risks             <!-- full level only -->

- <risk> → <how we would notice> → <mitigation>

## Rollout           <!-- full level only -->

- <flag, migration order, back-out>

## Plan

<!-- Filled by the plan skill: ordered slices, each with scenarios, files, first test, done check. -->

## Evidence

<!-- Filled by the prove skill: one row per scenario, with the command and result, labelled measured. -->
````

## Brief form (size S, in the reply)

```
Spec (brief): <intent in one sentence>
Non-goal: <one thing this does not do>
S1 Given …, when …, then …
S2 Given …, when …, then … (error path)
```

## Good and poor scenarios

| Poor | Why | Better |
| --- | --- | --- |
| S2 Handles errors gracefully | not observable, not one behaviour | S2 Given the server returns 503, when `upload` is called, then it retries twice with backoff and then rejects with `UploadFailed` carrying the last status |
| S4 Is fast | no number | S4 Given a 10 MB file, when uploaded over the test fixture, then completes within 2 s on CI |
| S5 Uses a queue internally | implementation, not behaviour | drop it, or move the constraint to Invariants: "uploads of one file never interleave" |
