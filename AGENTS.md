# For agents working with Jarvis OS

You can set this plugin up for the user without the browser page.

```
node setup/agent.mjs plan --json     # what is left, in order, and who has to do it
node setup/agent.mjs setup           # create memory, history, default skills, free tools
node setup/agent.mjs enable <id>     # switch a skill on (disable <id> to switch off)
node setup/agent.mjs install <id>    # install a program from the Tools list
node setup/agent.mjs connect <id>    # connect an MCP server
node setup/agent.mjs status          # one-screen summary
```

Paths are relative to the plugin root (`$CLAUDE_PLUGIN_ROOT` inside Claude
Code). Exit code 0 = done, 1 = something failed (the output says what),
2 = bad usage.

Rules:

- Each `plan` item has `who`: `agent` (run it), `ask` (installs software — get
  the user's yes first, one question for the batch), `person` (keys, sign-ins,
  apps — hand these to the user).
- Never handle a secret. `connect` reads a key from a hidden prompt, or with
  `--from-clipboard` from the clipboard; the user runs that one command
  themselves (in Claude Code: `!` + command). Never run it or read the
  clipboard yourself.
- Report from the command output, not from what you expected.

Data the commands read, if you need to look directly:

| File | What it is |
|---|---|
| `setup/profile.json` | title, step order, closing text |
| `setup/tools-catalog.json` | every tool: what it is, how it is detected, installed or connected |
| `setup/skills-catalog.json` | every skill: default on/off, what it needs |
| `memory-template/` | what a new memory folder starts with |

The `setup-for-me` skill wraps all of this for Claude Code.
