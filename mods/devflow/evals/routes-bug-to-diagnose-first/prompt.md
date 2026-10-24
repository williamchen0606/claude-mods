---
tags: [devflow, go]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash, TaskCreate, TaskUpdate]
---

Set up a tiny Python package `slugify` whose `slugify/__init__.py` currently reads exactly:

```python
import re

def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower())
```

It is meant to lower-case, replace runs of non-alphanumerics with a single hyphen, and strip leading/trailing hyphens. A bug report says `slugify("  Hello,  World!  ")` returns `"-hello-world-"` instead of `"hello-world"`. Reproduce it, fix it the proper way, and prove it is fixed. Use the devflow workflow.
