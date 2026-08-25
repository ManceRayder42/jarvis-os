---
name: research-notebook
description: Deep research on any topic via the NotebookLM CLI. Use whenever the user requests research on a topic, in any project, in any language. Triggers on phrases like "research this", "deep dive on", "do research on", "dig into", "find out about", "investigate", "look into", "research X for me". Creates or reuses a NotebookLM notebook, ingests 5–10 fresh sources, asks structured questions, and returns a cited synthesis. For multi-faceted topics, signals the main thread to fan out parallel sub-agents (web + hub + qmd) alongside.
metadata:
  triggers:
    - research this
    - deep dive on
    - do research on
    - dig into
    - find out about
    - investigate
    - look into
---

# research-notebook — NotebookLM-Powered Research Skill

Routes any research request through the user's local `notebooklm` CLI so collected sources, summaries, and Q&A become a durable, queryable artifact rather than scrollback.

## Prerequisite

This skill assumes the `notebooklm` CLI is installed and authenticated (Google account) separately — it is not bundled with this plugin. If `notebooklm list` fails outright, tell the user it needs installing/logging in rather than silently falling back to plain web search.

## When to use

- User asks to research, investigate, or dig into a topic (any language).
- User compares options, evaluates a tool, asks "what's the best way to do X", or wants a strategic overview.
- Single-shot factual lookups that would benefit from cited sources (e.g. "find out about Vercel Edge limits in 2026").

## When NOT to use

- Trivial single-fact answers the model already knows confidently and the user just wants in chat.
- Questions about the user's own hub/notes — that's the `qmd` skill, if installed.
- An already-existing project-specific research workflow the user has of their own.
- Pure code questions answerable by reading the repo.

## Workflow

### Step 1 — Extract the topic
Pull 1–5 keywords from the user message. If the topic is unclear or too broad to act on, ask ONE clarifying question before continuing. Preserve the user's language.

### Step 2 — Check for an existing notebook FIRST
```bash
notebooklm list
```
Fuzzy-match the topic against existing titles. If a clear match exists, reuse it:
```bash
notebooklm use <partial-id>
```
Otherwise create a new notebook with a Title Case + descriptive name including the year:
```bash
notebooklm create "Vercel Edge Functions Best Practices 2026"
```
Capture the new ID from output. Never duplicate an obviously-overlapping notebook.

### Step 3 — Decide scope: small vs large

| Scope | Heuristic | Action |
|---|---|---|
| **Small** | Single specific question, named tool/concept, "what is X", quick lookup | NotebookLM only |
| **Large** | Multi-faceted topic, "best way to do Y", N-way comparison, strategic question | NotebookLM **+** signal main thread to fan out |

For LARGE scope, your return text MUST include a `## Recommended Parallel Spawns` section so the main thread (Task Architect) can — IN PARALLEL with this skill — launch 2–3 sub-agents:
- one `WebSearch` / web-search agent for fresh web sources
- one hub-search agent (`qmd query` if installed, otherwise grep) for prior notes
- optionally one Explore agent for code-internal references

This skill itself does NOT spawn subagents.

### Step 4 — Collect 5–10 fresh sources
For each topic, find quality URLs via web search. For each chosen URL, prefer a clean-markdown extraction tool (e.g. the `defuddle` skill, if installed) over raw fetch — it's faster and cheaper on tokens. Then add to the notebook:
```bash
notebooklm source add <url>          # works for URL or YouTube directly
notebooklm source add ./extracted.md # if you already pulled markdown locally
```
Aim for diversity — official docs + practitioner blog + comparison piece + recent news + one critical/skeptical view.

### Step 5 — Ask the notebook 3–5 structured questions
```bash
notebooklm ask "What is <topic> and what problem does it solve?"
notebooklm ask "What are its strengths?"
notebooklm ask "What are its weaknesses or failure modes?"
notebooklm ask "How does it compare to <alternative>?"
notebooklm ask "Given <user context>, what would you recommend?"
```
The CLI emits inline `[1]`, `[2]` citations referencing source IDs — preserve them.

### Step 6 — Synthesize
Return a concise markdown report in the user's language:
- Topic + notebook id reused/created
- 5–8 bullet findings with `[n]` citations
- Recommendation grounded in the user's stated context (project, constraints)
- "Sources" list (titles + URLs)
- For LARGE scope: `## Recommended Parallel Spawns` block

## Constraints

- ALWAYS `notebooklm list` BEFORE creating — never duplicate notebooks.
- Notebook titles: Title Case, descriptive, year-stamped (`<Topic> <Qualifier> 2026`).
- This skill does NOT spawn subagents — it only flags parallel work for the main thread.
- One clarifying question max if topic is ambiguous; otherwise proceed.
- Match the user's language in chat output. CLI commands and notebook titles stay English.
- Never invent citations. If a notebook answer is empty/weak, say so.

## Failure modes

1. **NotebookLM rate limit / auth expired** — `notebooklm ask` returns auth error → tell user to run `notebooklm login` and retry; do NOT silently fall back to web-only research without flagging.
2. **Fuzzy-match ambiguity** — two existing notebooks look like matches → list both to the user and ask which (or "new notebook?"). Never silently pick one.
3. **`source add` failure** (404, paywall, robots block) — log the failed URL, swap in a replacement source from your search results, keep going. Don't abort the whole run for one bad URL.
4. **Topic too vague** ("research stuff for me") — ask ONE clarifying question, then proceed.
5. **YouTube source** — `notebooklm source add <youtube-url>` works natively; don't pre-scrape.
6. **Empty notebook answer** — surface honestly ("notebook had no answer on X"), don't paper over with model-prior content presented as cited.
