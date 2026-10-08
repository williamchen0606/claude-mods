# AGENTS.md

Guidance for coding agents working in this repository.

## What this repo is

A collection of **Claude Code mods**. A mod is a Claude Code plugin whose content is a TypeScript hooks module (panes, bands above the prompt, status line entries, toasts, slash commands, tool-call guards, and so on). The repo itself is a **plugin marketplace**: one `marketplace.json` at the root lists every mod, and each mod lives in its own folder under `mods/`.

The repo is at an early stage. Check what already exists under `mods/` before assuming any of the layout below is in place.

## Layout

```
.claude-plugin/marketplace.json   # lists every mod; one entry per mod
mods/<mod-name>/
  .claude-plugin/plugin.json      # { name, version, description[, types] }
  hooks/hooks.json                # { "modules": ["./register.tsx"] }
  hooks/register.tsx              # export const register: Register = (on, options) => { ... }
  types/index.d.ts                # only if the mod uses $.state: declares interface PluginState
  tests/*.test.ts                 # tests run by `claude plugin test`
  README.md                       # user-facing docs: what it does, install line, limits
```

marketplace.json:

```json
{
  "name": "claude-mods",
  "owner": { "name": "williamchen0606" },
  "plugins": [
    { "name": "<mod-name>", "source": "./mods/<mod-name>" }
  ]
}
```

Adding a mod means creating its folder, adding its entry to `marketplace.json`, **and** adding a row to the mods table in the root `README.md`. The entry's `name` must equal the `name` in the mod's `plugin.json`. Each mod is self-contained, so mods do not import from one another.

## Release notes

`RELEASE_NOTES.md` at the root records every user-visible change. Keep it current in the same commit as the change:

- Changing a mod's behavior means bumping `version` in its `plugin.json` (semver) and adding an entry under `<mod-name> <version>`.
- Adding a mod means an entry marked `（新 mod）` at its first version.
- Changes outside any mod (marketplace, docs, license, project settings) go under `Repo`.
- New entries go in the `未發布` section at the top; when they ship, move them under a dated `## YYYY-MM-DD` heading, newest first.
- Write entries in Traditional Chinese, like the README, describing what changed for the user rather than listing commits.

## Git workflow

- When a change is done and its checks pass (`claude plugin validate`, `claude plugin test`, `tsc`), open a PR to `main` and squash-merge it yourself, without asking first. Title the squash commit `<mod-name> <version>: <summary> (#N)`, or a plain summary for changes outside any mod.
- Fixes after a merge (for example, something found while testing) go in a new PR from a fresh branch off the latest `main`, merged the same way. Never reuse a merged PR or stack commits on its old history.
- The repo is public: never commit API tokens or other credentials, including in tests, docs or `.claude/settings.json`. A mod takes secrets through a `"sensitive": true` `userConfig` field or an environment variable, and tests use obviously fake values.

## Commands

```bash
claude plugin validate mods/<mod-name>   # manifest + hooks module, as the engine reads them
claude plugin validate .                 # marketplace.json
claude plugin test mods/<mod-name>       # runs that mod's tests/*.test.ts against the engine
tsc -p mods/<mod-name>                   # type-check (after the mod has loaded once; see below)
```

Running a mod during development:

```bash
claude --plugin-dir mods/<mod-name>      # load one mod straight from its folder
claude plugin marketplace add .          # or: register this repo as a local marketplace,
claude plugin install <mod-name>         #     install, then /reload-plugins after each edit
```

When a mod is installed from a local folder marketplace, Claude Code reads it from that folder. Edits show up after `/reload-plugins`, with no version bump or reinstall needed.

Install line for users (put this in the README, one per mod):

```
/plugin install <mod-name> --marketplace williamchen0606/claude-mods
```

## Writing hooks modules

- Every hook is `($, e, next)`. `$` is the engine interface, `e` is the frozen event input, and `next(e)` runs the plugins beneath this one and then the engine's own behavior. Return without calling `next` to answer for the event yourself. Call `next({ ...e, ... })` to rewrite the event for everything beneath.
- The module runs in an isolated environment with **no DOM and no Node APIs**. Go through `$` for files, processes, timers, model calls, and so on (`$.fs`, `$.process`, `$.clock`, `$.model`, ...).
- JSX compiles against the global `h`. Get elements from the surface's table with `const { Box, Text } = $.ui.resolve(e)`. Surfaces are `terminal`, `desktop`, `vscode` and `mobile`, and their element tables differ. If a tree doesn't validate on a surface, the engine draws its own instead.
- A hot reload resets module-level variables. Keep anything a drawing reads in `$.state` (session) or `$.store` (across sessions), declared in `types/index.d.ts` and referenced from `plugin.json` via `"types"`. Render hooks must never write state; write from handlers or other events.
- Guard hooks (anything that denies) should add a `.catch` handler so a throw fails closed: `on(...).catch(($, e, next) => next.called ? next(e) : { deny: '...' })`.
- The full API is in the generated types: once a mod has loaded, they are at `mods/<mod-name>/.claude-plugin/types/claude-code/index.d.ts`. Grep it for event and method names rather than guessing.
- `mods/*/.claude-plugin/types/` is generated by the engine, so don't edit or commit it (it is gitignored).
- Keep logic that doesn't need `$` in a separate module (e.g. `hooks/preview.ts`) so tests can import it directly. Tests run with no fs, network or process, and events like `prompt.edit` can't be raised from a test.
- Pasting an image into the prompt box does **not** raise `prompt.edit`; the box just gains an `[Image #N]` placeholder. To react to it, poll `$.prompt.read()` from a `$.clock.every` timer started in `session.start`. Claude Code stores each pasted image at paste time under `<temp>/claude-<uid>/<project>/<sessionId>/images/<N>.<ext>` (see `mods/image-preview`).
- Several mods can draw in the `AbovePrompt` band. A `ui.render` hook there should call `next(e)` first and return its own tree with that result inside (`<Box flexDirection="column">{below}...</Box>`), never a tree in place of it, so the other mods still show.
- Usage figures (rate-limit windows, context fill, cost) come from `$.session.usage()` and the `session.measure` event (see `mods/desktop-statusline`).
- To verify behavior in a real session from a headless container, run `claude --plugin-dir mods/<mod-name> --debug-file <log>` inside `tmux`, drive it with `tmux send-keys` / `tmux paste-buffer -p`, read the screen with `tmux capture-pane -p`, and grep the debug log for `<mod-name>`.
- Before a mod has loaded once, type-check it with a `tsconfig.json` kept **outside** the mod folder: copy the options from the header of the engine's `claude-code.d.ts`, and set `include` to that file plus the mod's `hooks`, `types` and `tests`.
