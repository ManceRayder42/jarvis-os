---
name: wiki-article
description: Write a wiki article capturing structure you learned about an active project in the user's hub. Use when you grepped or spawned Explore agents to understand a project and must record that knowledge before /done, or when the user asks to "write a wiki article", "document this in the wiki", or "add this to the wiki".
---

# Wiki article

## When this is required

If you grep, or spawn Explore-style agents, to learn the structure of an active project — and that project lives inside the hub (`<hub>/<project>/`) — write a wiki article **before** running `/done`. The reasoning: that discovery cost real tokens and real time; without a durable record, the next session repeats the same search from scratch, and that cost compounds every time. A short article converts one-time discovery into standing knowledge.

Skip this for shallow lookups (a single grep, one file read) — see "Length" below for the anti-fabrication guard that covers that case.

## Template

```markdown
---
topic: <topic>/<subtopic>
last-updated: YYYY-MM-DD
sources:
  - <file paths you actually read>
---

# <Component / Concept>

## What it is
2–3 sentences, concrete.

## When to read this article
- Bullet list of agent questions it answers

## How it works
Concrete mechanism with file:line references.

## Inputs / Outputs
- Inputs: ...
- Outputs: ...

## Failure modes
1. <mode> — detected by <symptom>, root cause <X>

## Code references
- `path/to/file:line` — what's there

## Related
- [[../other-article]]
```

## Save + register

1. Save to `<hub>/wiki/<project>/<topic>/<article>.md`.
2. Add it to that project's `<hub>/wiki/<project>/index.md` (create the index if this is the first article for the project).
3. Mention it in the session note's "Work done" section.
4. Then `/done` — its commit step picks up anything dirty under `<hub>/wiki/` automatically.

## Length

200–400 words. If discovery was shallow (1–2 files read, not enough to write 200 words honestly), do NOT fabricate — append a 5-line "what's missing for a wiki article" stub to the topic's `index.md` instead, so the next agent knows where to start.
