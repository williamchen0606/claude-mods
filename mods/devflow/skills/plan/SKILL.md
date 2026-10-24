---
name: plan
description: Turn an agreed spec into an ordered list of small, independently verifiable slices, each with its scenarios, files, first test and done check, and decide what can run in parallel. Use it after a spec exists for size M or L work, when the user says "plan", "break this down", "slices", "what order", or asks how to split work across agents, and whenever /devflow:go reaches its plan stage. Do not use it for size S work (go straight to tdd) or before the behaviour is agreed.
argument-hint: <path of the spec to plan from>
---

# plan: cut the work into verifiable slices

A plan is not a list of files to edit. It is an ordered list of **slices**, each of which can be built, tested and committed on its own, and each of which cites the spec scenarios it makes true. That property is what lets the work survive interruption, be reviewed in pieces, and be spread across subagents without merge pain.

Write the plan into the spec file's `## Plan` section (for a brief spec, into the reply), so the plan and the behaviour stay in one place. Keep it short: a plan is a checklist an owner runs box by box, not a design document. Design lives in the code and its tests.

## Read before cutting

1. The spec's scenarios, interfaces and invariants. Every scenario must land in exactly one slice.
2. The code the change touches: existing tests and their runner, module boundaries, shared types, anything several slices will need. Delegate wide reads to a subagent that returns file pointers, not dumps.
3. The repo's conventions for tests, commits and generated files, so slices end in a state the repo accepts.

## Cut the slices

Order by what blocks what, then by risk:

1. **Blocking first.** Shared types, schema or migration changes, new interfaces from the spec, test fixtures or fakes several slices need. Nothing fans out until these exist, because every parallel slice would otherwise invent its own version.
2. **Riskiest next, as a walking skeleton.** The thinnest end-to-end path through the new behaviour (one happy scenario). If the design is wrong, this is where it shows, while the cost of changing it is lowest.
3. **Then the remaining scenarios**, grouped so each slice touches a disjoint set of files where possible. Disjoint files are what make slices safe to run in parallel.
4. **Integration and cleanup last**: wiring, docs, removing the legacy path once every caller has moved. Migrate callers, then delete; no compatibility shims that outlive the PR.

Each slice is small enough to hold in your head and to commit alone. If a slice needs two unrelated tests to be believable, it is two slices.

## Write each slice

```
### Slice 2: retry loop with backoff
Scenarios: S1, S2
Files: src/upload/retry.ts, tests/upload/retry.test.ts
First test: S2 (server returns 503 twice, then 200); fails because retry() does not exist
Done when: S1 and S2 tests pass; `npm test -- upload` green; committed
Depends on: Slice 1
Parallel with: Slice 3 (disjoint files)
```

The **first test** line matters: it is what `tdd` starts from, and naming it now forces you to check the scenario is testable at all. If you cannot name a first test, the slice or the scenario is wrong; go back to the spec.

## Decide the parallelism

Parallel work is cheap to start and expensive to merge. Apply, in order:

- **Shared mutable state serialises.** Two slices that write the same file, table or config run one after the other, or the file is split first.
- **Disjoint slices may fan out** to subagents when there are three or more and each is self-contained. Give each the spec path, its slice text and the test command, and nothing it does not need. Spawn a fresh agent for each new piece of work rather than resuming an old one.
- **Tightly coupled work gets one owner** who sequences internally. One feature with five interlocking scenarios is one owner, not five agents.
- **Say why if a single worker is best.** "n/a: all slices touch the same module" is a fine answer and saves a reviewer wondering.

Rewrite this part of the plan at phase boundaries (after the blocking slices land, after the skeleton works), because what is independent changes as the code does.

## Checkpoints

For size L, put a checkpoint after the walking skeleton: show the user what works end to end and the plan for the rest before building the remaining slices. For M, the checkpoint at the end of `prove` is enough. Mark checkpoints in the plan so `go`'s task list shows them.

## Exit condition

The spec's `## Plan` section (or the reply, for brief) holds ordered slices; every scenario appears in exactly one; blocking slices are first; each slice names its first test and done check; parallel groups touch disjoint files or are marked serial with a reason. Set the spec's `status: building` and hand each slice to `tdd` in order.

Under `/devflow:go`, mark `plan` done and `tdd` active in `.devflow/state.json`, with a note like `slice 1/4`.
