# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The shared agent guidance lives in AGENTS.md. Keep it there so both files stay in sync:

@AGENTS.md

## Claude Code specifics

- Load the `plugin-authoring` skill before writing or debugging a hooks module. It points to the generated `claude-code.d.ts` for this build and to worked examples.
- That skill's default scratch location is the session mods folder. In this repo, write mods under `mods/<mod-name>/` and load them with `--plugin-dir` or a local marketplace instead.
