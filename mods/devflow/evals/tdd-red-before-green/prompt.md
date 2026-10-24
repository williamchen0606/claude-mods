---
tags: [devflow, tdd]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Using devflow's tdd skill, implement a function `parse_duration(s)` in `durations.py` (Python, pytest) for these scenarios:
S1 Given "90s", when parsed, then returns 90.
S2 Given "2m30s", when parsed, then returns 150.
S3 Given "1h", when parsed, then returns 3600.
S4 Given "abc", when parsed, then raises ValueError.
