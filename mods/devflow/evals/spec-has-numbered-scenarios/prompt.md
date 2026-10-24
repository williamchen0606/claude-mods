---
tags: [devflow, spec]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

I want a small Node.js CLI `envcheck` that reads a `.env.example` and a `.env` file and reports which keys from the example are missing or empty in `.env`, exiting non-zero when anything is missing. Don't build it yet, just write the spec for it with devflow's spec skill.
