---
name: learn
description: Use when the user shares a conclusion, note, or takeaway from something they're studying — a book, course, or article — and wants it captured into their personal learning archive. Trigger phrases include "what I learned today", "notes from the book", "conclusions from chapter X", plus the explicit `/learn` command. Also use when the user pastes raw notes/highlights from a book and asks to summarize them. Do NOT use for general reading recommendations, for ideas/brainstorms (that's a separate ideas-capture flow), or for daily reflective journaling with no book/material attached.
---

# Learn — book & study notes archive

The user is building a personal knowledge repository of what they read and study, one file per book/material, living flat under `<hub>/learning/`. This skill's job is capturing what they actually say — never inventing content — and keeping the archive tidy enough that it compounds instead of rotting.

The standing rule applies here without exception: **when synthesizing notes, do not include anything the user didn't write.** No chapter summaries pulled from a book's general reputation, no filled-in gaps. If they haven't told you something, it isn't in the file.

## Workflow

### 1. Identify the book/material

Read `<hub>/learning/index.md` (create it if missing — see below) to see what's already tracked.

- If the user names the book/material explicitly, or there's exactly one book with status `reading`, use it — no need to ask.
- If it's genuinely ambiguous (multiple books in progress, or nothing suggests which one), ask: **"Which book/material — or a new one?"** and list the known titles from the index. Never guess silently.
- New title mentioned → treat as a new book (step 3 creates its file).

### 2. Append the note

Slug the title (`the-lean-startup`, `atomic-habits`, etc.) → `<hub>/learning/<slug>.md`.

Append under a `## Conclusions` section, dated:

```markdown
### YYYY-MM-DD
<exactly what the user wrote — their words, lightly cleaned up for readability, nothing added>
```

If the file doesn't have a `## Conclusions` section yet, add it.

### 3. New book — create the file

No existing file for this title → create `<hub>/learning/<slug>.md`:

```markdown
---
type: learning
title: <Book Title>
author: <Author, if known — omit the line if not>
status: reading
started: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [learning]
---

# <Book Title>

## Conclusions
```

Ask for the author if the user didn't mention it and it's not obvious — don't guess a real book's author from memory either; if you're confident from common knowledge, it's still safer to state it as inferred rather than presented as something the user said (keep it out of anything framed as "their words").

### 4. Update the index

`<hub>/learning/index.md` is the at-a-glance list. Format:

```markdown
---
type: learning
updated: YYYY-MM-DD
tags: [learning, index]
---

# Learning Archive

| Title | Author | Status | Last updated |
|---|---|---|---|
| [The Lean Startup](the-lean-startup.md) | Eric Ries | reading | 2026-08-20 |
```

On every touch (new book, new conclusion, status change) update that book's row and bump `updated` in both the row and the index frontmatter.

When the user says they finished a book, flip `status` to `finished` in both the book file's frontmatter and the index row.

### 5. Summarize mode

When the user pastes raw notes or highlights and asks for a synthesized summary (not just a one-line conclusion), write a `## Summary — YYYY-MM-DD` section synthesizing **only the pasted material** — organize and tighten it, don't add outside context about the book. Save it to the book's file the same way as a conclusion.

## What NOT to do

- Don't fabricate chapter summaries, plot points, or "what this book is about" from training knowledge — only from what the user gives you.
- Don't create subfolders under `learning/` — keep it flat.
- Don't silently pick a book when more than one is ambiguous — ask.
