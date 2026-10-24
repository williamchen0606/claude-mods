---
name: ship
description: Land a proven change the way the repository wants it: small ordered commits, a briefing-style commit or PR body derived from the spec with its evidence, release notes and version bumps where the repo keeps them, and the spec marked done. Use it after prove, when the user says "ship", "commit", "open a PR", "land it", "wrap up", and whenever /devflow:go reaches its ship stage. Do not use it before prove has produced evidence, and do not merge or push to shared branches unless the repo's rules or the user say to.
argument-hint: <path of the spec, or nothing for a brief one>
---

# ship: land it so the history explains itself

Shipping is the last place to lose trust. A proven change with a vague commit message, a PR body that restates the diff, or a merge that broke the repo's own rules costs more review than the code did. The spec already holds the intent and the evidence; the job here is to carry them into the artefacts people will actually read later: the commits, the PR, the release notes.

## 1. Follow the repo's rules first

Read the repo's contribution guidance (CONTRIBUTING, AGENTS.md, CLAUDE.md, PR template) and do what it says about branches, commit format, version bumps, changelogs, generated files, and whether you may open or merge a PR yourself. Those rules win over anything below. When they say nothing, the defaults below apply.

Never force-push, rewrite someone else's branch, or merge to a shared branch without an explicit rule or instruction allowing it. Those are the irreversible actions the workflow always pauses for.

## 2. Shape the commits

- **Small and ordered.** Each commit is one verifiable unit that the repo passes on its own: the failing test, then the fix; the subtraction, then the reshape; the shared type, then its first user. A reviewer should be able to replay the argument commit by commit.
- **Titles** in the repo's convention. Default: Conventional Commits, `type(scope): subject`, imperative, no trailing period, naming the real symbol when one carries the change (`fix(parser): return [] for empty input`).
- **Bodies** say why, not what the diff already shows. Cite the spec scenarios the commit proves (`Proves S1, S2.`).
- Regenerate lockfiles and generated files with the repo's tooling, never by hand.
- Run the repo's checks once more on the final commit sequence if you reordered or squashed anything; a rebase is an edit.

## 3. Write the PR (or the squash commit) body as a briefing

A reviewer has the diff; the body is the one-minute briefing that tells them why it exists, what it leaves out, what it could break, and how it was proven. Use `##` headings in this order and drop any section with nothing to say:

- `## Why`: the problem and the approach, one to three sentences, from the spec's Intent.
- `## What changed`: one to three bullets. Name a symbol or path only when it carries the change.
- `## Scope`: what it covers and what it deliberately leaves out, from the spec's non-goals and open questions.
- `## Tradeoffs`: only alternatives a reviewer would otherwise ask about, from the decision log.
- `## Blast radius`: who or what this touches and why that is safe or risky.
- `## Verification`: one to three bullets, each a real command and its outcome, from the spec's Evidence. A performance change gives one number with unit, before → after.

Link the spec file if it is in the repo. Do not paste the spec; the reviewer can open it. Open PRs ready, not draft, unless the repo says otherwise.

## 4. Update the records

- Spec `status: done`, with a final decision-log line naming the PR or commit.
- Release notes, changelog and version bump if the repo keeps them, in the same commit as the change, in the repo's language and style.
- Follow-ups that came out of `prove` (sibling bugs, deferred scope) go where the repo tracks work: an issue, a TODO list the repo uses, or the spec's open questions. Not a comment in the code.

## 5. Merge, if allowed

If the repo's rules or the user tell you to merge (for example "squash-merge your own PR once checks pass"), wait for the checks to be green, merge the way the rules say, and confirm the base branch is green afterwards. Otherwise post the PR link and stop; the PR is waiting on its reviewers, and say so once.

## Exit condition

Commits are small, ordered and pass the repo's checks; the PR or commit body is a briefing with verification evidence; the spec is marked done; release notes and versions are updated where the repo keeps them; the change is merged or handed to reviewers per the repo's rules. The reply gives the PR or commit link and nothing the body already says.
