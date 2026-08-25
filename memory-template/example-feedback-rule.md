---
name: example-feedback-rule
description: Placeholder feedback memory — replace with a real behavioral correction or confirmed approach
metadata:
  type: feedback
---

This is a placeholder. A `feedback` memory records guidance you've given
Claude about how to work — a correction, or an approach you confirmed worked.
Unlike `project` memories, these should generalize past the one task they
came from.

Example of a real one: "Don't run the full test suite before every commit —
just the affected package. Full suite only before a PR."

**Why:** the full suite takes 8 minutes; the affected-package run takes 10
seconds and catches the same regressions for local commits.

**How to apply:** default to `go test ./affected/...`; run the full suite
only when explicitly asked or right before opening a PR.

Delete this file (and its line in MEMORY.md) once you've written your own.
