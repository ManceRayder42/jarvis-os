<!-- jarvis-os bridge block. Append this to your hub's CLAUDE.md (or the
     top-level CLAUDE.md of whatever directory you run the bridge from) so a
     running bridge session knows what to do with these words. Without this
     block, /new, /model, /effort, /compact, /context and /info arrive as
     plain text and get treated as ordinary conversation instead of commands.
-->

## Telegram Bridge — Session Control

This session may be running as the Telegram bridge (see the jarvis-os plugin's
`bridge/` scripts). When a message consists of one of the following words
(with or without the leading slash, optionally followed by an argument),
treat it as a command and run the matching `jarvisctl` invocation via Bash —
don't just talk about it:

| Message | Run |
|---|---|
| `/new` | `bash "${CLAUDE_PLUGIN_ROOT}/bridge/jarvisctl" new` |
| `/model <name>` | `bash "${CLAUDE_PLUGIN_ROOT}/bridge/jarvisctl" model <name>` |
| `/effort <level>` | `bash "${CLAUDE_PLUGIN_ROOT}/bridge/jarvisctl" effort <level>` |
| `/compact [note]` | `bash "${CLAUDE_PLUGIN_ROOT}/bridge/jarvisctl" compact [note]` |
| `/context` | `bash "${CLAUDE_PLUGIN_ROOT}/bridge/jarvisctl" context` |
| `/info` | `bash "${CLAUDE_PLUGIN_ROOT}/bridge/jarvisctl" status` |

Notes:

- `/new` and `/model`/`/effort` (which also restart) run the wrap-up
  (`/jarvis-os:done`) and then kill this very session — that's expected, the
  watchdog (if installed) or the bridge script brings a fresh one back up.
  Reply to the user first ("wrapping up and restarting — back in a minute")
  before running the command, since the process ends mid-flow.
- `/context` and `/compact` need the CURRENT turn to finish before they can
  run inside this same session — `jarvisctl` handles that queuing internally
  ("compact queued; it runs as soon as the current turn finishes" or the
  equivalent for context). Don't try to run `/compact` directly yourself in
  response to the message; let the script queue it via tmux.
- `/start`, `/help` and Telegram's own `/status` are intercepted by the
  telegram plugin itself and never reach this session — that's why the
  bridge's own status command is `/info`, not `/status`.
- If `jarvisctl status` reports rival MCP processes, that's a real
  configuration problem (two sessions polling the same bot token) — mention
  it plainly rather than silently retrying.
