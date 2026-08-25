---
name: done
description: End-of-session wrap-up — saves a session note to the hub, updates CONTEXT.md, and commits hub changes. Use this skill whenever the user types `/done`, `/wrap`, says "wrap up the session" / "save the session", or signals the conversation is ending and they want it documented. Also use when the user is closing a coding/research session and wants the work captured before they walk away — even if they don't say "/done" explicitly. Do NOT auto-trigger; wait for an explicit closing signal from the user.
---

# /done — Session Wrap-Up

Save a durable record of this session into the hub (see the plugin's hub concept — resolved from `JARVIS_HUB` env, then `~/.jarvis-hub-path`, then `~/jarvis-hub`). **Scale effort to session weight**: light/conversational → minimal note; substantial work (commits, decisions, multi-step) → structured note. Don't fabricate. Don't pad.

## Token discipline (read this first)

This skill runs at the end of every session, so cost compounds. Four rules to keep it cheap:

1. **No narration between tool calls.** Don't write "Running command...", "Edit succeeded, continuing...", "Now committing..." — those are wasted tokens. Run tools silently. Only the final confirmation is shown to the user.
2. **One bash call for context.** The resolver script bundles every piece of prep info you need. Don't make additional `git log`, `ls`, or `cat` calls unless the resolver output is genuinely missing something.
3. **Skip steps when they don't apply.** If the resolver printed no `dirty:` lines → no commit step. If session was light → no patterns scan. If `today_daily_note=(none)` → no link to it.
4. **Never full-Read `CONTEXT.md` or `patterns.md`.** Both can grow large over a long-lived hub. Step 4 updates `CONTEXT.md` via a script (no read); step 5 dedups patterns via `grep` (no read). If you ever must touch them directly, use `offset`/`limit` — never load the whole file.

## Workflow

### 1. Resolve context

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/done/scripts/resolve-context.sh"
```

The output is a flat key=value block. Key fields you'll use:

- `hub`, `sessions_dir`, `project` — where the session note goes and what the work belongs to
- `hub_is_git` — `no` means the hub isn't a git repo at all; skip the commit step entirely (see edge cases)
- `hub_dirty` — any uncommitted changes anywhere in the hub
- `sessions_dirty`, `wiki_dirty`, `memory_dirty`, `other_hub_dirty` — per-area dirt flags
- `dirty:hub:<path> <count>` lines — every dirty top-level path in the hub. This is the authoritative list for what to stage; don't guess from the flags alone.
- `hub_branch/_remote/_upstream/_ahead` — push state. See step 6.
- `wiki_recent_count` — wiki files modified in the last 24h (informational only)
- `current_branch` — branch of the repo you were *working* in (not the hub) — note it in the session note if relevant
- `today_daily_note` — path to today's daily note, or `(none)` (most hubs won't have this — that's fine, skip the line)
- `last_session_note`, `last_session_date` — for continuity context
- `today_session:<path>` lines — existing session notes for today (idempotency)
- `commit:<hash> <msg>` lines — commits in the hub since last session date

### 2. Decide session weight

- **Light** — purely conversational, no code changes, < 5 substantive turns, no decisions worth keeping. → 3-line note. Skip patterns.
- **Substantial** — code/files changed, real decisions, multi-step work. → Structured note + patterns scan.

Weight decides how much you *write*, never whether you commit. Step 6 is driven by the resolver's `dirty:` lines alone — a light session that still left `patterns.md` or `CONTEXT.md` dirty gets committed, because the alternative is drift that compounds silently.

When unsure, lean light. A thin honest note beats an inflated one.

### 3. Write the session note

Path: `<sessions_dir>/YYYY-MM-DD-<slug>.md`. Slug = 2-5 word kebab-case describing topic.

**Idempotency**: check the `today_session:` lines from the resolver. If one matches your slug → read that file, append `## Part 2 — HH:MM` with new content. Different slug, same date → new file (fine). Never overwrite.

**Substantial-session structure**:

```markdown
---
type: session
date: YYYY-MM-DD
project: <project>
status: <completed | in-progress | blocked>
tags: [session, ...]
---

# Session: YYYY-MM-DD — <Title>

**Goal:** <one sentence>
**One-line takeaway:** <single most important thing for future-you>
**Branch:** <current_branch> (only include if not main/master)

## Work done
- <commit-hash> <message> — <context if non-obvious>

## Decisions
- **<decision>** — <reasoning>

## Open threads
- <thread> — <what's blocked or pending>

## Next steps
- <concrete action>
```

For **light sessions**, drop the structured sections — frontmatter + Goal + 2-3 bullets is enough.

If `today_daily_note` exists, you may add a one-line `**Daily note:** [link](daily-notes/YYYY-MM-DD.md)` near the top. Skip if `(none)`.

Use the `commit:<hash> <msg>` lines from the resolver to populate "Work done" — those are real commits since the last session note.

### 4. Update CONTEXT.md

**Do NOT Read `CONTEXT.md`** — reading the whole file every run is the cost this step exists to avoid on a long-lived hub. Pipe a one-line entry to the updater instead; it prepends it, keeps the newest 12, and auto-archives the overflow — the model never loads the file:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/done/scripts/update-context.py" <<'ENTRY'
- Date: YYYY-MM-DD (topic) — one-line summary of what happened. Open: <blocker if any>. Note: `sessions/YYYY-MM-DD-<slug>.md`
ENTRY
```

You already have the content — you just wrote the session note. One line, newest-first. The script owns the `## Recent Sessions` region between the `SESSIONS:START/END` markers and creates `CONTEXT.md` from a minimal scaffold if it doesn't exist yet — the `## Active Projects` / `## Open Threads` / `## Recent Decisions` sections above that region are untouched by this script.

Re-running `/done` in the same day is safe: the script matches on the `sessions/…md` path in your entry and **replaces** the existing line instead of stacking a duplicate (it reports `replaced=1`). So keep the note path in the entry — it's what makes the update idempotent.

Exit code `2` means you piped an empty entry, which means step 4 didn't actually happen — fix the entry and rerun.

**State sections** (Active Projects / Open Threads) update separately and only when something genuinely changed: edit in place with a targeted `offset`/`limit` Read around that section, never a full-file Read.

### 5. Patterns (substantial sessions only)

Only if a *real* lesson surfaced — user corrected you, non-obvious tooling discovery, failure mode worth remembering. **Before appending, dedup**: grep `patterns.md` for similar phrasing — if the same lesson is already there, skip.

```bash
grep -i "<key-phrase>" "<hub>/patterns.md" 2>/dev/null
```

If `patterns.md` doesn't exist yet, don't create it from `/done` — that's a job for a memory-consolidation pass, not this skill. Skip step 5 silently in that case.

If no match, append under `## YYYY-MM-DD` heading:

```
- **Pattern**: <one-line>. **Why it matters**: <one-line>. **Trigger**: <when this applies>.
```

If nothing genuinely new, skip step 5 entirely. Manufactured patterns silently bias future decisions — worse than missing ones.

### 5.5. Wiki auto-update

**The contract:** after `/done`, the hub's wiki reflects this session's work. `/done` doesn't hand the work back to the user; it **detects what the wiki owes and writes it automatically**, then reports what changed.

Runs after the session note is written, BEFORE the commit in step 6.

**Step 5.5a — detect.** Run the freshness detector (pass nothing; it auto-finds this session's transcript):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/done/scripts/wiki-check.sh"
```

Parse the `WIKI_*` block from stdout:

- `WIKI_VERDICT` — `update_owed` | `up_to_date` | `skipped`
- `WIKI_REASON` — one-line explanation of the verdict (quote it if you report "skipped")
- `WIKI_PROJECT` — the project (hub subdirectory) the work touched
- `WIKI_FILES` — comma-separated basenames of the non-wiki files edited this session (targeting hint)
- `WIKI_EDITS` / `WIKI_DISCOVERY` — counts (real file edits / discovery actions)
- `WIKI_TARGET` — suggested article path skeleton

The detector locates this session's transcript itself: `$PWD` with `/`, `_` and spaces flattened to `-` under `~/.claude/projects/`, newest `.jsonl`. It **fails open** — any problem finding or parsing the transcript yields `skipped`, never a blocked `/done`.

One blind spot to cover yourself: it only classifies paths **inside the hub**. A session that spent its time editing this plugin's own skills/hooks/settings returns `up_to_date` because nothing hub-shaped was touched — if that's the kind of work this session actually did and it's worth remembering, write an article regardless of the verdict.

Trigger model: **any changed files**. If the session edited/created real files in a hub-tracked project (or did ≥3 discovery actions on one) and did NOT already write a wiki article, `WIKI_VERDICT=update_owed`.

- `up_to_date` → nothing owed. Skip to step 6.
- `skipped` → escape flag was set or transcript missing. Note "wiki-check skipped" in the confirmation and skip to step 6.
- `update_owed` → **continue to 5.5b. Do not skip. Do not ask the user first** — if the user prefers to review before writing, that's a one-time setting, not a per-session question.

**Step 5.5b — write the wiki (automatic).**

Articles live at `<hub>/wiki/<project>/<topic>/<article>.md`, indexed by `<hub>/wiki/<project>/index.md`. See the `wiki-article` skill for the template and the anti-fabrication guard.

1. Look at what changed. The session note you just wrote (step 3) + the `WIKI_FILES` hint + the work you actually did this session tell you which component/concept needs a wiki article.
2. Decide **update vs create**. List the project's existing articles:
   ```bash
   ls "<hub>/wiki/<project>"/**/*.md 2>/dev/null
   ```
   - If an existing article already covers this component → **Read it and update in place** (refresh `How it works`, `Code references`, bump `last-updated`, add new failure modes). Don't create a duplicate.
   - If nothing covers it → **create** using the `wiki-article` skill's template.
3. **Update the index.** Add or refresh the `[[topic/article|Title]]` line in `<hub>/wiki/<project>/index.md` so the new/changed article is discoverable.
4. Multiple distinct components touched → write/update one article each (don't cram unrelated work into one).

**Anti-fabrication guard (hard rule).** The wiki must never contain invented content. If the work was too shallow to write ≥200 honest words (1–2 file reads, a one-line tweak, no real structural understanding gained), do NOT manufacture an article. Instead append a 5-line *"what's missing for a wiki article"* stub to `<hub>/wiki/<project>/index.md` naming the component and where the next session should start. A thin honest stub beats a padded fake article. Note this choice in the confirmation.

**Manual opt-out** still exists: passing `/done --skip-wiki-check` sets `DONE_SKIP_WIKI_CHECK=1` in front of the detector call (or `touch /tmp/done-skip-wiki`) so it returns `skipped`.

The articles you just wrote are uncommitted; step 6 re-reads git state at commit time and picks them up (the resolver's `wiki_dirty` from step 1 predates them — don't read it as "nothing to commit"). Record which articles you wrote/updated; you'll list them in the confirmation and in the session note's "Work done".

### 6. Commit the hub (only what's dirty)

The point of this step is that nothing you just wrote stays unversioned. If `hub_is_git=no`, skip this whole step — there's nothing to commit and that's not an error (see edge cases).

One call does the whole step — staging, the push decision:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/done/scripts/commit-hub.sh" --slug <the-slug-you-used>
```

Add `--dry-run` first if you want to see the file list without committing.

It re-reads git state *at commit time* rather than trusting the step-1 snapshot — which matters because everything you wrote in steps 3–5.5 came into existence after the resolver ran. Staging by hand from the stale `dirty:` lines is exactly how freshly-written wiki articles used to get left behind.

Parse its output for the confirmation:

| Line | Meaning |
|---|---|
| `committed:hub <hash> <n> files` | landed |
| `nothing:hub` | clean, nothing owed |
| `pushed:hub <branch> -> <remote>` | synced |
| `nopush:hub <reason>` | deliberately not pushed — report the reason verbatim |
| `error:hub <msg>` | say so plainly in the confirmation; don't retry, don't force |

What it guarantees, so you don't have to re-verify:

- **Allowlist only** — `sessions wiki patterns.md conversation-log.md CONTEXT.md daily-notes ideas research learning`. Any file that looks hand-curated (`MEMORY.md`, any `user_*`/`project_*`/`feedback_*`/`reference_*` memory file) can never be staged by this script — those are the user's own edit-in-progress, same reasoning as never touching `CLAUDE.md` in a code repo.
- **Refuses to commit mid-rebase/merge** — reports `error:` instead of burying an unfinished operation.
- **Never auto-pushes** — the hub holds personal memory by definition, so pushing requires an explicit `JARVIS_HUB_PUSH=1` opt-in even when a remote and upstream exist. See the script's own comment for the reasoning.

**`conversation-log.md`, if present, is typically owned by a scheduled memory-consolidation pass, not `/done`.** Two writers on a rolling-window file produce duplicate entries and a corrupt boundary. `/done` commits whatever consolidation left there; it doesn't author it.

`git push` from a *code* repo is a separate, higher-stakes operation than this — this exception covers the hub only, and only with the explicit opt-in above.

### 7. Confirm

Short. Skip lines that don't apply.

```
Saved.

Session: sessions/YYYY-MM-DD-<slug>.md
Wiki: <article(s) written/updated> / up to date / stub added / skipped
Patterns: +N / nothing added
Context: updated
Hub: <N files> committed / clean
Commit: <hash> / no changes
Push: <branch> -> <remote> / no remote / skipped — <reason>
```

The `Wiki` line is required. State exactly what happened: which articles you wrote or updated (by path), or "up to date" if nothing was owed, or "stub added" if the anti-fabrication guard fired, or "skipped" if the detector was skipped.

If something failed, say so explicitly: `Missed <X> because <reason>.`

---

## Edge cases (load only when hit)

For unusual cases — detached HEAD, no git repo, write errors, hub-not-found, conflicting today files — read `references/edge-cases.md`. Don't preload it.

## What this does NOT do

- Push a hub with no upstream, or push without the explicit `JARVIS_HUB_PUSH=1` opt-in (see step 6).
- Modify or stage `MEMORY.md` or any hand-curated memory file.
- Write `conversation-log.md` (typically owned by a memory-consolidation pass, if the user has one configured).
- Send anything to a chat bridge, Telegram, or any other notification channel — this skill reports into the session only.
- Close tasks in daily notes (separate concern).
- Auto-trigger — only on explicit closing signal.
