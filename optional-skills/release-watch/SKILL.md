---
name: release-watch
description: Watch the Claude Code changelog (and optionally the Anthropic news feed) and report only what matters for how this user works, as recorded in the hub. Use when the user says "run the release watch", "what's new in Claude Code", or from a schedule. Silence is a valid outcome.
---

# Release watch

The changelog gets several releases a week. This skill reads everything and
forwards almost nothing. The bar is high: a digest that cries wolf gets ignored,
which is worse than no digest. No narration between tool calls.

## Steps

1. **Gather (no model tokens):** run
   `bash "${CLAUDE_PLUGIN_ROOT}/skills/release-watch/scripts/fetch-changes.sh"`.
   It prints JSON: new changelog versions since the last run (with raw text) and
   unseen news entries. It exits non-zero on a fetch failure; if so, report that
   plainly and stop. Never say "nothing new" when the network failed.
2. **Empty case:** if both counts are zero, say so in one line and stop. Write no digest.
3. **Learn the user's setup** from the hub (`MEMORY.md` and the notes it links to):
   which features, tools, connectors and workflows they actually use.
4. **Filter.** Keep only entries that change something for this user. A typical run
   keeps 0 to 3 items out of dozens. Keep: capabilities that change how work is
   structured (sub-agents, hooks, skills, permissions, session and context
   management), anything that cuts token cost or extends context, new models and
   effort or pricing changes, connector changes in categories they use, and
   security fixes touching credentials or transcripts. Drop: platforms and IDEs they
   do not use, cosmetic fixes, bug fixes for unused features, anything an earlier
   digest already covered.
5. **Per kept item** write 1 to 3 lines: what shipped, what it enables for them, and
   a verdict: Adopt (clear win), Investigate (plausible, needs a look) or Watch.
   Quote or paraphrase only what the changelog says; if ambiguous, mark Investigate.
6. **Write the digest** to `<hub>/release-watch/YYYY-MM-DD.md` with frontmatter
   (`type: release-watch`, `date`, `versions_scanned`, `kept_count`), under 60 lines,
   each item linking its version or URL.
7. **Update state** in `<hub>/release-watch/state.json`: set `last_version` to the
   newest version scanned (not the newest kept) and append every news URL seen to
   `seen_news`, trimmed to the last 200.
8. Tell the user the verdicts in a few lines, Adopt items first.

## Hub location

The script resolves the hub from `JARVIS_HUB`, then `~/.jarvis-hub-path`, then
`~/jarvis-hub`, the same way the rest of the plugin does.

## Options

- `RELEASE_WATCH_NEWS=0` skips the news feed and reads the changelog only.
- Scheduling is up to the user. Per the working rules, a new schedule runs
  propose-only (digest written, nothing acted on) for its first week.
