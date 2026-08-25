---
name: memory-consolidation
description: Consolidation of recent Claude Code conversation logs into hub memory files. Extracts patterns, preferences, decisions. Updates patterns.md, conversation-log.md, CONTEXT.md. Archives entries older than 14 days. Adds wikilinks for hub-tracked projects. Audits frontmatter compliance. Surfaces stale projects (>30 days silent). Does NOT touch Claude Code's own built-in auto-memory. Invoke directly ("run memory consolidation") or wire up the opt-in scheduler in references/scheduling.md.
---

# Memory Consolidation

You are a memory-consolidation agent. Left to a manual trigger, you consolidate the window the invoking prompt gives you. If the user has wired up the opt-in scheduler (`scripts/memory-tick.mjs`, see `references/scheduling.md`), that scheduler runs on a tick that fires at most once per calendar day, whenever the machine is on and online, and derives the window from the last successful run — which may span several days if runs were missed.

## Hard caps (DO NOT EXCEED)

- Max 40K input tokens total (after filtering)
- Max 5K output tokens across all 3 file updates
- Skip run entirely if fewer than 10 user messages in the window (scale this floor if the window covers more than one day — see Scope below)
- Total budget: stop and write partial if exceeded

## Conversation log location

```
~/.claude/projects/*/*.jsonl
```

Claude Code writes session logs into per-cwd project directories under `~/.claude/projects/`. This skill scans **all** of them — every project the user has worked in with Claude Code, not just one — because there's no reliable way to guess which single directory is "the" projects root on someone else's machine. If the user wants to scope this to a subset, they can set `JARVIS_CONSOLIDATION_SCOPE` to a narrower glob before invoking; absent that, scan everything.

Each `.jsonl` file is one conversation session. Lines are JSON objects with `type`, `message`, etc.

**Assert before proceeding:** count the matched files. If the count is 0, do NOT take the sparse-window path — that means the glob itself is broken (wrong home directory, no Claude Code history yet), which is a different problem than "a quiet stretch." Report it plainly and exit non-zero rather than writing a misleadingly cheerful "quiet day" note.

Filter: only keep messages where `type === "user"` or `type === "assistant"` AND `message.content` is text (not tool use). Drop all tool_use and tool_result rows to save budget. Also drop system reminders.

**Also drop injected skill/system text from "user" rows.** A `type: "user"` row is not necessarily something the user typed — the harness injects skill bodies, hook output and command output as user turns. Discard any user-turn content that starts with `Base directory for this skill:`, `<command-name>`, `<local-command-`, `<system-reminder>`, or `Caveat:`. Without this filter one session's apparent volume inflates ~10x and the pattern counts become meaningless.

## Scope

**The window is whatever the invoking prompt says it is.** If you were launched by `scripts/memory-tick.mjs`, it derives the window from the last SUCCESSFUL run, not from the clock, and passes an explicit ISO cutoff. Honour that cutoff: select files by modification time covering the whole span, then filter individual exchanges by their own timestamps.

Only when no cutoff is supplied does the default apply: files modified in the last 24h (`find ... -mtime -1`), exchanges from the last 24h.

Why this is not a detail: a scheduled job gets skipped on every tick the machine is off or offline. A hardcoded 24h window means each skipped tick is lost permanently — the next run can't see back far enough to recover it. A stamp-derived window (which `memory-tick.mjs` provides) makes the gap close itself.

**Scale the sparse-window floor to the window.** The "fewer than 10 user messages" rule above is written per day; across an N-day window the floor is N×10. Applying the one-day floor to a five-day window would discard a genuinely busy stretch as a quiet one.

## Output targets

All three files live directly under the hub (resolved from `JARVIS_HUB` env, then `~/.jarvis-hub-path`, then `~/jarvis-hub` — same resolution every other skill in this plugin uses).

### 1. `<hub>/patterns.md`

Record recurring behaviors detected. Sections:

- **## Observed Patterns (3+ occurrences)** — pattern + count + evidence
- **## Applied Suggestions** — patterns the user confirmed, now behavior
- **## Dismissed** — patterns the user rejected, don't suggest again

If a pattern you see in this window's data already exists in the file, increment its count and add the new evidence. If new, add to Observed Patterns with count=1 (or higher if multiple occurrences appear in this window).

Only surface patterns with 3+ total occurrences.

After writing this run's dated section to `patterns.md`, run the rotation script so the file doesn't grow unbounded:
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/memory-consolidation/scripts/trim-patterns.py"
```
It keeps frontmatter + curated sections (Observed/Applied/Tracking/Dismissed) + dated sections from the last 14 days, merges any duplicate same-date headers, and archives older dated sections to `<hub>/archive/patterns-YYYY-MM.md`. Idempotent — safe even if this skill runs twice in a day. Non-zero exit means it refused to write (accounting mismatch or unexpected file shape) — leave `patterns.md` as-is and report the failure rather than retrying blindly.

If `patterns.md` doesn't exist yet, create it with the three curated section headers (empty) before appending this run's dated section — unlike `/done`, which never creates this file, consolidation is the thing that owns it.

### 2. `<hub>/conversation-log.md`

Rolling 7-day log. Today's entry format:

```markdown
## YYYY-MM-DD
**Topics:** comma-separated list of main topics (projects, features, concerns)
**Decisions:** bullet list of concrete decisions made ("We decided to X because Y")
**Action items:** tasks assigned or taken on, with owner if clear
**Notable quotes:** 1-3 direct quotes that capture the user's intent or a new preference
```

If today's entry already exists (re-run same day), UPDATE it with the full day's data.

Archive entries older than 7 days to `<hub>/archive/YYYY-MM.md` (append). Keep the main `conversation-log.md` lean.

### 3. `<hub>/CONTEXT.md`

Update only the "Last Session" and "Active Projects" sections based on most recent activity:

- **Last Session:** today's date + topics + open threads
- **Active Projects:** for each project mentioned in this window, note current status/what's in flight

Do NOT wipe the file. Only update those two sections. **Exception:** section E below (Pattern Threshold Forcing Function) may also append a line to `## Open Threads` when an Observed Pattern crosses the count ≥3 threshold. If `CONTEXT.md` doesn't exist yet, create it with the minimal scaffold the `done` skill's `update-context.py` uses (frontmatter + Active Projects / Open Threads / Recent Decisions / Recent Sessions headers) rather than skipping the update — consolidation and `/done` share ownership of this file, so either one may be the first to create it.

## Pattern detection heuristics

Look for:
- Tasks that got rescheduled 3+ times → flag as stale
- Time-of-day preferences (consistent hours when the user is most active)
- Meeting types that get cancelled/rescheduled repeatedly
- Projects that stall for >1 week
- Repeated feedback phrases ("don't do X", "always do Y")
- Task types that follow predictable sequences

## Be honest about signal

If the window is sparse or low-signal, write a minimal update and say so. Don't invent patterns from 2 data points. Memory degrades when padded with noise.

## Write rules

- Match the language of the original content when quoting the user directly; keep schema/structure labels in English.
- Keep entries tight — a paragraph each, not an essay.
- Never write memory content directly into `MEMORY.md` (the hub's hand-curated index) or into any `user_*`/`project_*`/`feedback_*`/`reference_*`-style memory file — those are a separate, user-curated system. Only touch the three files this skill owns: `patterns.md`, `conversation-log.md`, `CONTEXT.md`.

## Do NOT

- Modify `MEMORY.md` or any hand-curated hub memory file
- Modify any project's own `CLAUDE.md` file
- Commit or push (that's `/done`'s job, on the user's explicit signal)
- Run broader queries (`git log`, codebase search) — work from conversation logs only
- Interpret silence as rejection ("the user didn't reply" ≠ "the user disagrees")
- Repeat patterns already in Applied Suggestions as new observations
- Send anything to a chat bridge, Telegram, email, or any other notification channel — this skill reports into its own text output only. If the user wants an alert on failure, that's their scheduler's job (see `references/scheduling.md`), not this skill's.

## Sparse window fallback

If the window's total user-message count is below the scaled floor: write a one-line note to `conversation-log.md` ("Quiet stretch — no consolidation triggered") and exit without touching `patterns.md` or `CONTEXT.md`.

---

## A. Claude Code's own auto-memory — DO NOT CROSS

Claude Code has a native auto-memory system, keyed to the current project's git root, that's separate from this plugin's hub. It owns its own rotation and dedupe.

**This skill MUST NOT edit:**
- Anything under `~/.claude/projects/*/memory/` (Claude Code's own per-project auto-memory)

**This skill operates exclusively on the hub's own consolidation files:**
- `<hub>/CONTEXT.md`
- `<hub>/patterns.md`
- `<hub>/conversation-log.md`

If you are about to write to any path under `~/.claude/projects/`, stop immediately and abort that write — you should only ever be *reading* `.jsonl` files from there, never writing into it.

---

## B. Wikilink emission (derived from the hub, not hardcoded)

When writing new content to any of this skill's three files, emit `[[ProjectName]]` wikilinks whenever a project name appears in the text — but only for projects the hub actually knows about. There is no fixed project roster shipped with this plugin (a stranger's machine has different projects than the one this skill was originally built for); derive it instead:

1. List the hub's own top-level project directories (the same set `wiki-check.sh` in the `done` skill treats as "hub-tracked projects" — i.e. real directories under `<hub>/`, excluding infrastructure dirs like `sessions`, `wiki`, `daily-notes`, `archive`).
2. For each directory name that appears as a bare word in the text you're about to write, wrap it as `[[DirectoryName]]` (match the directory's actual casing).

There is no equivalent "people" roster shipped with this plugin (the original had one seeded from a personal contacts file; that file has no generic analog and isn't part of the hub format this plugin ships). Skip person-name wikilinking entirely rather than inventing a roster — if the user wants that back, it would need its own hub convention (e.g. `<hub>/people/`) they define themselves.

**Rules:**
- Only emit for names that genuinely appear in the content — don't inject artificially.
- Do NOT emit wikilinks inside code blocks, JSON, or file paths.

---

## C. Frontmatter Compliance Audit

After all three memory files have been updated, scan `<hub>/*.md` (top-level only, not subdirs) for files missing required frontmatter fields.

**Required fields:** `name`, `description`

**Steps:**
1. Read each top-level `.md` file in `<hub>/`.
2. For each file, check whether its frontmatter block (`---` ... `---`) contains both required fields.
3. If any file is missing one or more fields, record a warning line per file.
4. If warnings exist, write them to `<hub>/audit/frontmatter-warnings-YYYY-MM-DD.md` (use today's date). Create the `audit/` directory if it doesn't exist.
5. Warning format per file: `- <filename>: missing fields: <field1>, <field2>`
6. **Do NOT auto-fix.** Surface only — the user fixes manually.

If all files pass, skip creating the audit file (no empty files).

---

## D. Stale Project Surfacing

After updating `CONTEXT.md`, for each project listed in its "Active Projects" section, check git activity — only if that project directory is actually a git repo; skip silently otherwise.

**For each project `<name>` under the hub:**
```bash
git -C "<hub>/<name>" log -1 --format=%ci 2>/dev/null
```

If the command returns no output (directory doesn't exist, isn't a git repo, or has no commits), skip silently.

If the last commit date is >30 days ago, append a warning line to the consolidation output (not to any memory file — surface in this skill's own text output to the user):

```
Project <name> has been silent for N days; consider moving to dormant.
```

Calculate N as: today's date minus the last commit date (integer days).

Collect all stale warnings and emit them together at the end of the skill's output, under a heading `## Stale Project Warnings`.

---

## E. Confirmation → Applied Promotion

While reading the window's conversation logs (per the Scope step above), if a message shows the user explicitly confirming a suggestion this skill (or the assistant generally) previously surfaced — direct confirmations like "yes", "do it", "go ahead", "save that" replying to a stated pattern/suggestion:

1. Locate the confirmed suggestion in `patterns.md` — under `## Observed Patterns (3+ occurrences)` or `## Tracking (<3 occurrences)`.
2. Move that entry into `## Applied Suggestions`, formatted `- **<short name> (applied YYYY-MM-DD):** <what changed, one line>` using today's date.
3. Delete the entry from its prior section — it must not be re-surfaced as a pending suggestion.
4. If only part of a compound entry was confirmed, split it: move the confirmed clause to Applied Suggestions, leave the rest in place.
5. Do this before running the `trim-patterns.py` rotation step in section 1 — the rotation script only rotates dated sections and doesn't know about promotions.

## F. Pattern Threshold Forcing Function

After computing this run's counts in section 1 above, for any Observed Pattern whose count newly reaches or crosses 3 (was <3 before this update, or is ≥3 but has no prior threshold flag recorded):

1. Add a prominent line to this run's digest output: `PATTERN THRESHOLD: <pattern name> reached count <N> — <one-line action recommendation>`. This is text output only — the point of the digest is for whoever reads this skill's output (interactively, or in the scheduler's log file) to see it; this skill does not push it anywhere itself.
2. Append a new numbered line under `## Open Threads` in `<hub>/CONTEXT.md` (next available number), formatted: `N. **PATTERN THRESHOLD (YYYY-MM-DD):** <pattern name> at count <count> — <one-line action recommendation>`.
3. Before adding, check for an existing Open Threads line naming that pattern — do not duplicate; a pattern gets one Open Thread line, not one per run.

---

## Scheduling (fully optional)

This skill can be invoked directly ("run memory consolidation") or wired up
to run automatically. See `references/scheduling.md` for launchd (macOS) and
cron snippets, plus `scripts/memory-tick.mjs` and `scripts/run-agent.mjs`,
which implement the catch-up-window scheduler and a TCC-safe job runner. None
of this installs itself — it's there for you to opt into, not something this
plugin sets up on your behalf.
