---
name: memory-setup
description: "Set up memory", "build my memory system", "תגדיר זיכרון", "תבנה לי מערכת זיכרון". Creates the layered CLAUDE.md block, knowledge pack, wiki/raw folders and checks the memory hooks.
---

# Memory setup

One deterministic script does all the work. Do not recreate its steps by hand.

1. Run it (add `--dry-run` first if the user asks what it would change; add `--lang he` when the
   user writes Hebrew, otherwise `--lang en`):

   `node "${CLAUDE_PLUGIN_ROOT}/skills/memory-setup/scripts/memory-setup.mjs" --lang <he|en>`

2. Relay the summary table it prints, in the user's language, without rewriting the paths. Say in
   one line what changed: `created`, `updated` or "nothing to do".
3. If a row says `error` or `skipped`, quote that row and the fix it names. Never edit the user's
   `CLAUDE.md` yourself: the script only touches its own marked block.
4. Close with the one habit: just correct me ("no, I said...") and it becomes a rule, say "undo"
   to remove it; say "done" when a session ends.

It is safe to run again: a second run prints "Nothing to do". It never installs software; if `qmd`
is missing it only prints how to get it.
