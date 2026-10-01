---
name: setup-for-me
description: Do the Jarvis OS setup for the user instead of sending them to the setup page — create the memory, switch skills, install and connect tools, and hand back only the steps a person must do. Use when the user says "set me up", "set it up for me", "finish the setup", "configure Jarvis", "what's left to set up", "תגדיר לי", "תסיים את ההתקנה", right after the plugin was installed, or when the session-start note says the memory isn't set up yet.
---

# Setup, done by you

Everything on the `/jarvis-setup` page has a command. Run them yourself; the
person should only do what genuinely needs a person.

The tool: `node "${CLAUDE_PLUGIN_ROOT}/setup/agent.mjs" <command>`. It drives
the same setup server the page uses, so results are identical. Add `--json`
to `status`, `plan`, `skills` or `tools` for machine-readable output.

## Steps

1. **Read the plan:** `plan --json`. Every item has `who`:
   - `agent` — run its `how` command now, no need to ask.
   - `ask` — it installs software on their computer. List these in one
     message ("I'd install GitHub CLI, qmd and ffmpeg — OK?") and run the
     ones they approve. One question for the batch, not one per tool.
   - `person` — a key, a sign-in, or an app only a human can operate.
     Collect these for the end.
   Items with `recommended: false` or `optional: true` are not done by
   default: list them once at the end under "Also available", one line each.
   An item's `then` is a follow-up for the person (e.g. an OAuth sign-in via
   `/mcp`) — pass it on with that item.
   Every `how` is a complete, absolute command: run it exactly as given,
   unquoted, from any directory. A `how` starting with `!` is for the person.
2. **Do the `agent` items**, starting with `setup` if the memory doesn't
   exist (it also connects the recommended free tools, so don't connect those
   again). Run independent ones back to back without narrating each.
3. **Run `plan` again** to confirm what actually changed. Report from the
   command output, never from what you expected to happen.
4. **Hand over the `person` items** as a short numbered list, each with the
   exact thing to type.

## Keys and sign-ins — never through you

- Never ask the user to paste a key, token or password into the chat, and
  never put one in a command line.
- For a connection that needs a key, tell them to run it themselves inside
  Claude Code by typing `!` and then the command, e.g.
  `! node "<plugin root>/setup/agent.mjs" connect <id>` — it asks for the key
  with typing hidden. Print the real plugin root path so they can copy it.
- Sign-ins (`gh auth login`, `notebooklm login`, `/mcp` for OAuth
  connections) are the person's: give the exact command.

## Report

Three short parts: what you did (from the output), what they need to do
(numbered, copyable), and anything that failed with its exact error. Then
remind them of the one habit: say "done" at the end of a session.

## Don't

- Don't open the setup page unless they ask for it — the point is that they
  don't have to.
- Don't install anything marked `ask` without their yes.
- Don't retry a failed install in a loop; show the error and the manual line
  the tool printed.
