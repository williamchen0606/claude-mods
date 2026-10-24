---
tags: [devflow, go]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash, TaskCreate, TaskUpdate]
---

Create a tiny Python package `slugify` with one function `slugify(text)` in `slugify/__init__.py` and a pytest test file. It must lower-case, replace runs of non-alphanumerics with a single hyphen, and strip leading/trailing hyphens. Then: there is a bug report that `slugify("  Hello,  World!  ")` returns `"-hello-world-"` instead of `"hello-world"`. Reproduce it, fix it the proper way, and prove it is fixed. Use the devflow workflow.
