# Tracks × sizes

What each track runs at each size. "spec (chat)" is the `spec` skill's brief level: three to five lines written in the reply rather than a file. "spec (file)" is its standard or full level under `docs/specs/` (or the repo's own place for specs).

| Track | S | M | L |
| --- | --- | --- | --- |
| **bug** | diagnose → tdd → prove → ship | diagnose → spec (chat: what changes besides the fix) → tdd → prove → ship | diagnose → spec (file) → plan → tdd per slice → prove → ship |
| **feature** | spec (chat) → tdd → prove → ship | spec (file, standard) → plan (in the spec) → tdd per slice → prove → ship | spec (file, full) → user checkpoint on open questions → plan → tdd per slice with a checkpoint after the first slice → prove → ship |
| **refactor** | tdd (characterisation test if missing) → refactor → prove → ship | spec (file: the behaviour contract as a test list) → plan → tdd → prove → ship | spec (file) → plan with migrate-then-delete order → tdd → prove → ship |
| **spike** | spec (chat: question, time box, done-when) → build → prove (answer) → stop | spec (file: question, options, done-when) → build the cheapest discriminating experiment → prove (measurements) → decision log → stop | as M, but with one slice per option, often in parallel subagents, then a comparison table |
| **chore** | do → prove → ship | do → prove → ship | spec (chat: what changes for users) → do → prove → ship |

## Stage exit conditions

A stage is done when its exit condition holds, not when its text was written.

| Stage | Exit condition |
| --- | --- |
| diagnose | The failure reproduces on demand with one command or script, and the root cause is named with the evidence that points to it. |
| spec | Intent, non-goals and numbered behaviour scenarios exist; every open question has an assumption; the user has seen the summary (or the work is S and the three lines are in the reply). |
| plan | Ordered slices, each naming its scenarios, files, first test and done check; blocking work is first; parallel slices touch disjoint files. |
| tdd | For each slice: a test that failed for the intended reason, then passed after the smallest change; refactor done with tests still green. |
| prove | Every scenario has a row: test or check, command, result, measured. The repo's own checks ran. The diff was read adversarially. |
| ship | Commits are small and ordered; the PR or commit body carries intent, behaviour and evidence; the spec status is updated; release notes written if the repo keeps them. |

## Re-routing

Re-route when the work reveals it was mis-sized or mis-tracked. Common cases:

- A bug fix needs a new interface: upgrade to M, write the spec (chat or file) before the fix.
- A feature's first slice shows the design is contested: pause tdd, go back to spec, add the alternatives to the decision log, and ask or decide.
- A refactor changes observable behaviour: it is now a feature; spec the new behaviour.
- A spike's answer is "yes, do it": close the spike with the decision, open a feature track with a fresh spec that cites the spike.

Say the new route in one line when you change it, so the user sees the change in plan.
