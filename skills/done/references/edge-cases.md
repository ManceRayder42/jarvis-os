# /done — Edge cases

Load this only when the main flow hits something unusual. Common case is in `SKILL.md`.

## No git repo at all (`hub_is_git=no`)

`commit-hub.sh` returns `nothing:hub` and exits 0 — nothing breaks. In the confirmation, swap the commit line for: `Commit: not a git repo — nothing committed.` The session note still gets written to `<hub>/sessions/`. This is a normal, supported state — the hub is not required to be a git repo at all (see the plugin's README).

## Hub repo in detached HEAD or mid-rebase

`commit-hub.sh` already detects this and returns `error:hub repo mid-rebase/merge — commit skipped` (or `nopush:hub detached HEAD`). Don't try to fix it — surface it:

```
Missed the commit — the hub is mid-<rebase|merge>. The session note is saved; finish the <rebase|merge> and commit manually.
```

## Push rejected (non-fast-forward)

Someone (another machine, another session) pushed first. Don't `--force`, don't auto-pull-rebase — a hub merge conflict is the user's call. Report:

```
Push rejected — the remote is ahead. Your commit is local and safe. Run `git pull --rebase` manually.
```

## Multiple projects touched in one session

Pick the *primary* project — whichever had more activity (more commits, more files touched, more user attention). Write a single session note in that project's context. Mention secondary projects in "Work done" with a short bullet. Don't fork into multiple notes.

If genuinely 50/50 split, write the note to `<hub>/sessions/` with a multi-project slug like `multi-<projectA>-<projectB>-X`.

## User runs `/done` twice the same day, same slug

Per SKILL.md idempotency rule: read existing file, append `## Part 2 — HH:MM` block. Use local time (`date +%H:%M`).

If the user runs `/done` three times — `## Part 3 — HH:MM`, etc. The numbering is mechanical, no need to be clever.

## User runs `/done` twice the same day, different slugs

Both are fine — write a new file. The first isn't "wrong"; it's a checkpoint. `CONTEXT.md`'s "Recent Sessions" region gets a new line for each (`update-context.py` handles this — see SKILL.md step 4).

## Session was very short (3-4 turns, no work)

Don't refuse, but write the smallest honest note:

```markdown
---
type: session
date: YYYY-MM-DD
project: <project>
status: completed
tags: [session, brief]
---

# Session: YYYY-MM-DD — <slug>

**Goal:** <one line>
**Outcome:** <one line — what actually happened>
```

Skip patterns. Skip commit if `sessions_dirty=no`. Confirm with one line: `Short session documented.`

## File write fails (permissions, disk, etc.)

Don't pretend success. Surface:

```
Missed writing the session note — <error>. Nothing was saved; try manually or check permissions on <sessions_dir>.
```

The `CONTEXT.md` update / commit attempt should also abort — the session note is the anchor; without it, the rest is misleading.

## Hub directory doesn't exist at all

Should never happen if the resolver worked, but if it does: `mkdir -p <sessions_dir>` and continue. This is expected on a genuinely fresh install where the user hasn't run `/jarvis-setup` yet — don't treat it as an error, just create what's needed.

## patterns.md doesn't exist

Don't create it from `/done` — that's a memory-consolidation concern, not this skill's. If it's missing, skip step 5 silently. No need to mention it in the confirmation; an absent file just means nothing to dedupe against yet.

## Conflicting today files (resolver shows multiple `today_session:` entries)

Different slugs = fine, write a new file as planned. Same slug as your intended one = idempotency append (Part 2). If two existing today files have similar topics to yours, default to "different slug, new file" — don't try to merge/dedup automatically.

## Resolver script errors out

Falls back to manual routing rules in SKILL.md step 1, plus:
- `sessions_dirty` → run `git status --short -- sessions/` manually in the hub
- `current_branch` → `git rev-parse --abbrev-ref HEAD` in cwd (or skip if not in a repo)
- Skip `today_daily_note`, `last_session_note`, `commits` — they're nice-to-have, not required

If the script is broken, also surface a one-line note in the confirmation: `resolve-context.sh failed — manual fallback used.`
