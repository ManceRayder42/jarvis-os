---
name: recall
description: Recall what happened or was decided in earlier Claude Code sessions. Use when the user asks "what did we decide about X", "where did we stop", "what happened last session", or when the session-start index lists a relevant past session. Reads auto-written notes first, transcripts second. Answers in chat only. EXPERIMENTAL, opt-in.
---

# recall (experimental, opt-in)

Answers questions about earlier sessions from two sources: short auto-written
session notes, and the raw transcripts Claude Code already keeps. Stop as soon
as the question is answered.

## How the experimental part works

When the user opts in, a `SessionEnd` hook (`hooks/session-recall.mjs`)
starts a detached worker. The worker builds a secret-filtered digest of the
transcript (user prompts, assistant text, one-line tool summaries; all tool
results are dropped), makes **one `claude -p` call** (model `sonnet`, effort
`low`, no tools) and writes a note of at most 300 words to
`<hub>/staging/session-notes/YYYY-MM-DD-<session8>.md`. A `SessionStart` hook
prints an index of the last six sessions of the current project. Nothing is
written to the hub proper: notes stay in `staging/` until the user promotes
one by hand (propose-only).

Cost and limits, stated plainly:

- **One `claude -p` call per session** that has 5 or more user messages. It
  uses the user's Claude subscription usage (or API credit). Smaller sessions
  are skipped and cost nothing.
- **`claude -p` needs a valid login.** An expired sign-in makes every worker
  call fail silently; the failure is only in `<hub>/staging/session-recall.log`.
  Fix with `claude auth login` or `claude setup-token`.
- **SessionEnd is not verified when a Claude Desktop window is closed** or the
  app is quit. It is verified only by feeding the hook its JSON by hand and in
  the CLI. If no note appears after a Desktop session, that is the likely cause.
- Notes are written by a model from a digest. They can repeat a wrong claim
  from the transcript. Treat them as pointers, not facts.
- Transcripts are deleted by Claude Code after its retention period
  (`cleanupPeriodDays`, 30 days by default). Notes outlive them.
- Not tested on Windows.

## Turn it on / off

The hooks are registered for everyone but do nothing until opted in.

- On: `touch "<hub>/.session-recall"` (the hub is `JARVIS_HUB`, else the path in
  `~/.jarvis-hub-path`), or set `JARVIS_SESSION_RECALL=1` in the environment.
- Off: delete that file; `JARVIS_SESSION_RECALL=0` forces it off even if the
  file exists.
- Optional: `JARVIS_RECALL_MODEL` (default `sonnet`), `JARVIS_CLAUDE_BIN`
  (path to the `claude` binary if it is not on PATH for hooks).
- Per the working rules a new automation runs propose-only for its first week:
  read the staging notes before relying on them or promoting any.

## Using it

1. **Auto notes first** (cheap, already summarized):
   `node "${CLAUDE_PLUGIN_ROOT}/skills/recall/scripts/search.mjs" <term> [more terms] --notes-only`
   lists matching notes; then read the 1 to 3 relevant files in
   `<hub>/staging/session-notes/`.
2. **Transcripts second**, only if the notes do not answer it:
   `node "${CLAUDE_PLUGIN_ROOT}/skills/recall/scripts/search.mjs" <term> [more terms] [--all] [--limit N]`
   prints date, session id and a short redacted snippet per hit. It reads user
   prompts and assistant text only, never tool results. `--all` searches every
   project instead of the current one.
3. If one session clearly holds the answer, read just that part: run
   `node "${CLAUDE_PLUGIN_ROOT}/skills/recall/scripts/extract.mjs" ~/.claude/projects/<project-folder>/<session-id>.jsonl`
   (a compact, secret-filtered digest). Do not Read raw `.jsonl` files.

## Rules

- **Label every recalled claim with its date and say it is not verified now.**
  Example: "Said on 2026-11-03: the plan was changed (not verified current)."
  A transcript shows what was said, not what is true today. For current state
  (plans, prices, whether a job is enabled, whether a file exists) offer to
  check it live before relying on it.
- Say who decided: only call it the user's decision when the user clearly chose
  it; otherwise "the assistant recommended".
- **No hits is not "we never decided".** Say "I found nothing in the notes or
  transcripts I can read" and mention the limits above.
- Answer in chat only. Do not save the answer as a note or into hub memory;
  promoting a fact to durable memory is a separate, deliberate step.
- Never print tokens, keys or passwords even if a snippet looks like one. The
  scripts redact, but do not repeat anything that looks like a secret.
