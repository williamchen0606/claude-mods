# Principles

Short, with the reason each one exists. These are the assumptions behind the stage rules; when a rule and a principle disagree, the principle wins.

## Agree before building

- **Spec before code.** Code written before the behaviour is agreed gets rewritten. The spec is cheap to change; the code is not. For an S task the spec is three lines, but it still comes first.
- **Non-goals are part of the spec.** Models and people both drift into "while I'm here". Writing what is out of scope keeps the diff reviewable and the tests focused.
- **Attack the premise once.** Before writing the spec body, ask whether a smaller change, a deletion or a configuration tweak meets the intent. Subtract before you add.
- **Write for a reader with no context.** The spec is read by reviewers, by future you, and by agents that were not in this conversation. Everything needed to implement and verify goes in the file, not the chat.

## Test before implementing

- **Behaviour over implementation.** Tests (and scenarios) describe what a caller observes, not how the code does it, so a refactor does not break them and a bug does.
- **Red for the right reason.** A test that fails because of a typo proves nothing. Read the failure message before writing the fix.
- **Smallest change that makes it green.** Then refactor with the test as the safety net. Big first drafts hide which part made it pass.
- **A bad test is worse than no test.** One that mostly asserts on mocks, depends on timing, or needs heavy infrastructure for a small change will be deleted or ignored. Prefer the closest executable check instead and say so.

## Prove before claiming

- **Measured, inferred, guessed.** Label every claim about behaviour. "Tests pass" means you ran them in this session and saw the summary.
- **An inconclusive check is not a pass.** A test that was skipped, a command that timed out, a check on the wrong surface: say so and treat it as missing.
- **Read your own diff as the reviewer.** Unrelated changes, dead code, comments that narrate the obvious, behaviour the spec did not ask for: remove them before anyone else sees them.
- **Fix root causes.** A symptom patched is a bug moved. When the diagnosis stops at "it works now", it is not done.

## Work with the human and the machine

- **Reversible work proceeds, irreversible work pauses.** Asking permission for every edit wastes the user's attention; skipping it for a force push loses their work.
- **Never block on small decisions.** Record the question and your assumption in the spec, continue, surface the list at the next checkpoint.
- **Durable state lives in files.** Conversations compact, sessions end, hot reloads reset. The spec, the plan and the evidence survive because they are files in the repo.
- **Guard the context window.** Delegate wide reads and independent slices; keep design and verification in the lead. A lead that has read 40 files has no room left to think.
- **Sequence verifiable units.** Each slice can be built, tested and committed on its own. If a slice cannot be verified alone, it is two slices or it is wrongly cut.
