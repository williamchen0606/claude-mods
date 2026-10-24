---
name: go
description: Entry point of the devflow workflow. Use it whenever the user hands over a piece of engineering work (a feature, a bug, a refactor, an experiment, a chore) and has not said how to approach it, and always when they type /devflow:go or say "devflow", "use the workflow", "spec first", "do this properly". It classifies the task into a track, sizes it, and runs only the stages that size needs (spec, plan, TDD build, prove, ship). Do not use it for questions that need no change to the repo, or when the user already named a single stage such as /devflow:spec or /devflow:tdd.
argument-hint: <what to build, fix, change or explore>
---

# go: route the task, then run the stages it needs

Most of the waste in agent-driven engineering is not bad code. It is code written before anyone agreed what it should do, tests written after the fact to match it, and "done" claimed without evidence. The workflow below exists to close those three gaps, and to do it in proportion: a one-line bug fix must not pay for a full specification, and a cross-cutting feature must not skip one.

So the first job is to decide **how much process this task deserves**, and only then to start. That decision is the "dynamic" part. Make it explicitly and say it out loud in one line, so the user can override it.

## 0. Pick up unfinished work

Before routing, check whether this is a continuation: `.devflow/state.json` (below) with a stage still `pending` or `active`, or a spec in the repo's spec folder with `status: agreed` or `building`. The workflow keeps its state in files precisely so a new session can continue it, so look before starting over.

- If the request continues that work, or is just "continue", resume instead of re-routing: say the route you are resuming in one line, re-read the spec (for S work, the progress file's `task`), rebuild the task list from the file's stages, and pick up at the `active` stage. Re-check that stage's exit condition rather than trusting its mark.
- If the request is new work, say in one line which unfinished route you are replacing, then route the new task below. The old spec stays as it is.

## 1. Classify the track

Read the request and the repo (a quick look at the files it names, the test layout and any CONTRIBUTING/AGENTS/CLAUDE guidance). Pick one track:

| Track | Signals in the request | What drives the work |
| --- | --- | --- |
| **bug** | broken, fails, wrong output, crash, regression, a stack trace, "used to work" | a reproduction, then a regression test |
| **feature** | add, support, implement, allow, new, "I want it to" | behaviour scenarios in a spec |
| **refactor** | clean up, restructure, extract, rename, simplify, "no behaviour change" | the existing tests as the contract, plus the ones that are missing |
| **spike** | explore, prototype, try, compare, evaluate, "is it feasible", POC | a question to answer and a time box, not shippable code |
| **chore** | dependencies, config, CI, docs, release, formatting | the repo's own conventions; small and mechanical |

If the request is really a question (explain, why does, how does) and needs no change, answer it with evidence from the code and stop. The workflow is for changes.

If two tracks fit, the one that carries the risk wins: a "small feature" that fixes a bug is a bug (reproduce it first); a refactor that changes behaviour is a feature (spec the new behaviour).

## 2. Size it

Size decides which stages run. Estimate from the code, not from the wording of the request, because users describe big things casually and small things anxiously.

| Size | Typical shape | Rule of thumb |
| --- | --- | --- |
| **S** | one or two files, no interface or data-shape change, behaviour obvious from the request, you could hold the whole diff in your head | spec fits in three lines of chat |
| **M** | one module or feature slice, a new or changed interface, user-visible behaviour, a handful of scenarios | spec needs a file |
| **L** | crosses modules or services, migrations, concurrency, security, anything with open design questions or more than one reasonable design | spec needs a file, a plan with slices, and probably checkpoints with the user |

When in doubt between two sizes, pick the larger: the cost of an unneeded spec section is minutes, the cost of a missing one is a rewrite. And re-size when you learn something: an S that turns out to touch a shared type is an M. Stop, say so, and write the spec before continuing.

## 3. Compose the stages

The stages are skills in this plugin. Load each with the Skill tool when you reach it (`devflow:spec`, `devflow:plan`, `devflow:tdd`, `devflow:diagnose`, `devflow:prove`, `devflow:ship`).

Read `references/tracks.md` and take the route for this track and size from its table. That table is the only copy of the routes, so the route you announce is the one the stages and their exit conditions expect. In short: bugs start from a reproduction, features and refactors from a spec (three lines in chat at S), spikes answer a question and never ship, and chores skip the spec unless users see a change. A stage in the table that is not a skill (`do`, `build`, `refactor`) is work you do directly, with its own task-list entry like any other stage.

Then:

1. Say the route in one line, for example: `Track: bug · Size: S · Stages: diagnose → tdd → prove → ship`.
2. Open a task list (TaskCreate, or the repo's own tracker if it has one) whose first items are the stages of the route, one per stage, copied from `references/tracks.md`. A stage you decide not to run stays in the list with `skip: <reason>`, so a reader sees the choice rather than wondering about a gap. Task-specific items go after the stages. A hot reload or a long session cannot lose the plan if it lives in the list.
3. Write the progress file (below) with the same stages, the first one `active`.
4. Run the stages in order, loading each skill as you reach it. Mark a stage done, in the task list and in the progress file, only when its exit condition (in `references/tracks.md`) holds, not when its text was written; mark the next one `active` as you start it.

## Progress file

The band above the prompt (this plugin's hooks module) reads `.devflow/state.json` in the directory the session started in, the project root. Write it there by absolute path, not under a directory a shell `cd` moved to, or the band never sees it. Keep it current and the person sees where the work is without asking: write it when you say the route, and again at every stage change; it costs one small Write.

Keep the file out of the repo's history. Run this once from the project root; it works in a git worktree and does nothing outside git, with no edit to `.gitignore` and nothing to commit:

```bash
p=$(git rev-parse --git-path info/exclude 2>/dev/null) && { mkdir -p "$(dirname "$p")"; grep -qx '.devflow/' "$p" 2>/dev/null || echo '.devflow/' >> "$p"; } || true
```

```json
{
  "track": "bug",
  "size": "S",
  "task": "slugify strips edge hyphens",
  "stages": [
    { "name": "diagnose", "status": "done" },
    { "name": "tdd", "status": "active", "note": "slice 1/1" },
    { "name": "prove", "status": "pending" },
    { "name": "ship", "status": "skipped", "note": "user commits" }
  ],
  "spec": "docs/specs/2026-10-24-slugify.md"
}
```

`status` is one of `pending`, `active`, `done`, `skipped`; `note` is a few words (a slice count, a skip reason); `task` is a few words naming the work; `spec` is the spec file's path once there is one. Exactly one stage is `active` at a time. The file is a mirror of the task list, not a second plan: when the route changes, rewrite both.

## 4. How to behave while running

- **Reversible work proceeds; irreversible work pauses.** Editing files, running tests, committing to a branch: go. Force pushes, deleting data, deploys, sending anything outside the repo, changing shared config: stop and ask, unless the user said "run until done" or "going to bed".
- **A question you could answer by running something is not the user's to answer.** Behaviour, timing, output, whether a test separates: run the experiment (a short spike) and let the result decide. Ask only for product or preference calls no experiment can settle, and batch those into the spec's open questions.
- **Do not block on the human for small decisions.** Record the open question and your assumption in the spec, proceed under the assumption, and surface the list at the next checkpoint. Stop only when different answers would lead to materially different work.
- **Write durable state to files, not to the conversation.** The spec file is the memory. Anyone, including a fresh agent with none of this context, should be able to pick up the work from it.
- **Keep the context window for thinking.** Delegate wide reads and independent slices to subagents when they exist, with file pointers rather than inlined dumps; keep design decisions and verification in the lead. Review a subagent's diff yourself; never pass its summary through as your own.
- **Label claims.** Measured (you ran it and saw it), inferred (it follows from something measured), or guessed. "Tests pass" without a command you ran is a guess.
- **Name the principle when it changed a decision.** When a rule in `references/principles.md` made you do something other than the obvious thing (delete instead of add, split a slice, refuse a test), say which one and what it changed. Read that file once per session; it is short.
- **No is an acceptable answer.** Asked whether to add scope or shown an approach, give your real judgment. "This does not earn its place" is a complete reply when it is true.

## Exit

The task is done when the last stage's exit condition holds: for shippable tracks, `prove` produced evidence for every scenario and `ship` landed the change the way the repo wants; for a spike, the question is answered in writing with measurements.

Close with a reply that stands on its own for someone who did not watch: the route you took and anything that changed from the original sizing, what changed for the user of the code and for its next maintainer, the evidence (commands and results, labelled), and what is still open. Short declarative sentences. Every claim carries its evidence or its label in the same sentence.
