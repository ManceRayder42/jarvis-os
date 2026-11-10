# Jarvis OS: details

How it works underneath, the exact skill list, and the license paper trail. None of it is required to use the plugin. Start with the [README](../README.md).

## How the memory actually works

Claude Code already has a memory feature — but it's tied to **git** (the
version-control system many coding projects use) and specifically to a
project's **repository** ("repo" — the folder Git is tracking). If your
current folder isn't one Claude Code recognizes, that memory silently doesn't
load. No error, no warning — the context you expected just isn't there, and
you don't find out until you've explained the same thing for the fourth time.

Jarvis OS sidesteps that: **one hub folder, one `MEMORY.md` file, injected
into every conversation's starting context regardless of where you launched
from.** A small startup script does this in milliseconds and silently does
nothing on any error — a memory feature that breaks your session start would
be worse than no memory feature.

**Obsidian is recommended, not required.** Obsidian is a popular
note-taking app; if you have it, the setup page links your memory folder into
it automatically so you can browse and cross-link your notes visually.
Everything works fine with a plain folder of text files if you don't.

## Setup, in more detail

`/jarvis-setup` opens a short-lived local web page (only reachable from your
own computer, protected by a one-time code in its link) where you pick a
memory folder (default `~/jarvis-hub`), turn skill groups on or off
individually, and optionally point at an Obsidian vault (Obsidian's word for
one of its note collections).

**By default, nothing runs in the background — no "daemon"** (a program that
keeps running invisibly after you close the window). The setup page itself
closes automatically: it exits when you close its browser tab, or after 10
minutes regardless, and it dies the moment the terminal that opened it does.
There's nothing to remember to shut down.

The **one** exception is something you turn on yourself, on purpose: the
[phone assistant](#phone-assistant-telegram-bridge) below, or the optional
[memory-consolidation scheduler](../skills/memory-consolidation/references/scheduling.md).
Both of those genuinely do keep running in the background — that's the whole
point of them — and both come with the exact one-line command that removes
them again.

Until you run setup at all, the plugin stays quiet: one line at the start of
a conversation saying it isn't configured yet, nothing more.

## The full skill list

| | |
|---|---|
| **Memory that persists** | One hub folder, loaded into every conversation from anywhere on disk |
| **`/done`** | Closes a session: writes a note, folds it into memory, saves the change |
| **`/grill-me`** | Interviews you about a plan until it actually holds together |
| **`wiki-article`** | Turns a discovery session into a reference article instead of scrollback |
| **`learn`** | Book and course notes into a structured, dated learning log |
| **`eli5`** | Explains a concept or codebase as a simple visual page instead of a wall of text |
| **`defuddle`** | Any web page → clean, readable text, locally |
| **`qmd`** | Search across your own notes by keyword and by meaning |
| **`research-notebook`** | Multi-source research with citations, via NotebookLM |
| **`memory-consolidation`** | Folds recent session logs into memory so patterns persist |
| **`media-gen`** | Image/video generation via fal.ai — **off by default**, needs your own key |
| **`council`** | Runs a real decision past five independent advisors, peer-reviewed anonymously, then a chair's verdict |
| **`setup-for-me`** | Does the setup itself when you say "set me up" — you only do keys and sign-ins |
| **`knowledge-pack`** | Builds a durable, sourced reference pack on a subject instead of re-researching it every time — **off by default** |
| **`preflight`** | Pre-deploy sanity check: broken `.env` quoting, risky project paths, swallowed errors — **off by default** |

Most of the above load by default. More ship **optional, off by
default** — see [Optional skills](#optional-skills) for what they are and why
they're not part of the default set:

| | |
|---|---|
| **`playwright-cli`** | Automated screenshots and error-checking for a website you're building |
| **`obsidian-markdown`** | Wikilinks, embeds, callouts, and note properties |
| **`obsidian-bases`** | `.base` files — table/card/list views over your notes |
| **`json-canvas`** | `.canvas` files — mind maps and flowcharts |
| **`obsidian-cli`** | Command-line control of a running Obsidian vault |
| **`voice`** | Turn a voice message into text, or a reply into speech, via ElevenLabs — **off by default**, needs your own key |
| **`knowledge-pack`**, **`preflight`** | Listed above; also optional, so switching them off really unloads them |
| **`release-watch`** | Reads the Claude Code changelog for you and keeps only what changes something for your setup — silence is a normal result |

Skills that run locally and need no account load by default. Anything that
costs money, needs a large first-run download, or is only useful with
software you may not have ships turned off. A free plugin shouldn't ask for a
credit card — or a hundred-megabyte download — in the first five minutes.

## Working rules

New memory folders also get `working-rules.md`, loaded into every session
next to your memory: how Claude should delegate (every worker reports **what
it did not check**, every reviewer gets a rubric), which model to route
mechanical lookups to, why a new automation runs propose-only for its first
week, and the order to look things up in (your notes → exact search →
semantic search → the web last). Edit it freely — it is yours. Existing
memory folders get it the next time you run `/jarvis-setup`; nothing already
there is overwritten.

## Optional skills

`playwright-cli`, `obsidian-markdown`, `obsidian-bases`, `json-canvas`,
`obsidian-cli`, and `voice` live in a separate `optional-skills/` folder
rather than the `skills/` folder every other skill loads from. That's
deliberate, not an oversight: Claude Code loads *everything* under a
plugin's `skills/` folder, so a simple on/off setting can't hide one of
them — it would just be another setting that looks like it does something
but doesn't (a real bug an earlier version of this plugin's Obsidian setting
had). Instead, enabling one of these actually **moves it** into
`skills/` (technically: creates a link there, called a "symlink," pointing
back to the original — same effect as a real copy, without needing two of
everything), so Claude Code only ever sees it once it's genuinely turned on.

**Why some of these are optional, not default:**
- `playwright-cli` — no licensing issue; its first run downloads real browser
  software (tens of megabytes), the same "not in the first minute" bar
  `media-gen` is held to.
- `voice` — needs your own ElevenLabs key, same reasoning as `media-gen`.
- `recall` — **experimental.** Writes a short note for each finished session
  into `<hub>/staging/session-notes/` (staging only, never your memory) and
  lets you search past sessions. It costs one `claude -p` call per session,
  so it stays off until you turn it on: `touch <hub>/.session-recall` or set
  `JARVIS_SESSION_RECALL=1`. Details in `optional-skills/recall/SKILL.md`.
- `obsidian-markdown` / `obsidian-bases` / `json-canvas` / `obsidian-cli` —
  useless, and just clutter in your skill list, if you don't use Obsidian.
  Detected automatically (the app is installed, or you gave setup a vault
  path); if neither is true, the setup page points you at
  [obsidian.md/download](https://obsidian.md/download) (macOS one-liner:
  `brew install --cask obsidian`) instead of silently doing nothing.

**Terminal command**, for anyone who'd rather not use the setup page:

```bash
node setup/skills-materializer.mjs enable obsidian       # all four Obsidian skills
node setup/skills-materializer.mjs enable playwright-cli voice
node setup/skills-materializer.mjs status                # what's currently on
node setup/skills-materializer.mjs disable obsidian playwright-cli voice
```

Run these from the plugin's installed folder (`echo $CLAUDE_PLUGIN_ROOT` from
a live Claude Code conversation prints it). Re-run `enable` after a
`claude plugin update` — an update replaces the plugin's files from scratch,
which undoes anything switched on at runtime, the same way it would undo any
other local edit to an installed plugin.

## Codex and Cursor

`node setup/agent.mjs install-host codex|cursor` wires the host to the same
memory folder, the same skills and the same tool list. It writes only the
files the host documents (table below), is safe to run twice, backs up a file
before changing it (`<file>.jarvis-os-backup-<timestamp>`), never overwrites
anything that is yours, and `uninstall-host` removes exactly what it added.
`--dry-run` shows what it would do. It needs no server and no new dependency.

Clone the repo to a stable place first (`git clone https://github.com/ManceRayder42/jarvis-os ~/.jarvis-os`),
because the hook and the instructions contain that path. Moved it, or updated
the clone? Run `install-host` again; it rewrites the paths. (A Claude Code
plugin cache folder changes with each version, so do not point Codex or Cursor
at it.)

```bash
node setup/agent.mjs setup --host codex          # create the memory folder (Claude Code is not required)
node setup/agent.mjs install-host codex          # or: cursor
node setup/agent.mjs install-host codex --mcp all        # also Context7, Supabase, ...
node setup/agent.mjs install-host cursor --print-user-rule   # text for Cursor's User Rules
node setup/agent.mjs install-host cursor --project ~/code/app   # also write .cursor/rules/jarvis-hub.mdc there
node setup/agent.mjs host-status codex
node setup/agent.mjs uninstall-host codex
```

`connect <tool-id> --host codex|cursor` adds one MCP server the same way.
`--mcp none`, `--no-skills`, `--no-hook`, `--no-instructions` skip a part;
`--skills link|copy` overrides how skills are placed.

### What each host gets

Status words: **full** = same behaviour as Claude Code, **fallback** = works,
but through a different and weaker mechanism, **not possible** = the host
offers nothing.

**Codex CLI**

| Pillar | Mechanism | Docs | Status |
|---|---|---|---|
| Memory loads at session start, any directory | `SessionStart` hook (matcher `startup\|resume\|clear`, so it does not re-inject on compact or fork) in `~/.codex/hooks.json` running `hooks/session-start.mjs --host codex`; plain stdout becomes developer context | https://developers.openai.com/codex/hooks (now served at https://learn.chatgpt.com/docs/hooks) | **full after a one-time trust**: Codex runs a new hook only after you review it with `/hooks`; a changed command needs review again |
| Same, before the hook is trusted, or if hooks are off | managed block in `~/.codex/AGENTS.md` (or `AGENTS.override.md` when that exists and is not empty, because Codex reads it instead; an empty override is skipped) telling the agent where the hub is and to read it first | https://developers.openai.com/codex/guides/agents-md (https://learn.chatgpt.com/docs/agent-configuration/agents-md) | **fallback**: the model has to obey an instruction instead of being handed the text |
| Skills | one symlink per enabled skill in `~/.agents/skills/` (Codex follows symlinked skill folders) | https://developers.openai.com/codex/skills (https://learn.chatgpt.com/docs/build-skills) | **full**; Codex detects new skills automatically, restart it only if they do not appear |
| Tools (MCP) | managed block of `[mcp_servers.<id>]` tables in `~/.codex/config.toml`; stdio servers get `startup_timeout_sec = 60` and `npx -y`; a server you already defined is left alone; keyed servers read `bearer_token_env_var` and no key is written | https://developers.openai.com/codex/mcp (https://learn.chatgpt.com/docs/extend/mcp) | **full** for http and stdio servers. OAuth sign-in is `codex mcp login <id>` |
| Slash commands (`/jarvis-setup`, `/done`) | none: Codex skills are invoked as `$done`; the setup page is `node setup/server.mjs` | | **not possible** as slash commands |

**Cursor**

| Pillar | Mechanism | Docs | Status |
|---|---|---|---|
| Memory loads at session start | `sessionStart` hook in `~/.cursor/hooks.json` running `hooks/session-start.mjs --host cursor`; prints `{"additional_context": ...}` | https://cursor.com/docs/hooks | **fallback**: Cursor documents the hook as fire-and-forget, and does not say it runs in the CLI agent. The Agents Window drops its `additional_context` (known Cursor issue, https://forum.cursor.com/t/174143, 2026-10-09; the editor agent panel works). One unconfirmed report says CLI 2026.11.05 does not load `~/.cursor/hooks.json` (https://forum.cursor.com/t/177989) |
| Memory, reliable path | `~/.cursor/rules` is only partly supported by Cursor (needs `---` frontmatter, loads only for workspaces under your home folder), so install-host does not write it. User Rules are set in the app: Customize > Rules (older builds: Cursor Settings > Rules > User Rules); `--print-user-rule` prints the text to paste. Per project, `--project <dir>` writes `.cursor/rules/jarvis-hub.mdc` with `alwaysApply: true` | https://cursor.com/docs/context/rules | **fallback**: one manual paste, or one rule file per project; cannot be automated for all directories. Cursor CLI: the documented sources are `.cursor/rules` (`--project`) or a project-root `AGENTS.md` / `CLAUDE.md`; the User Rule is not documented for the CLI |
| Skills | one copy per enabled skill in `~/.cursor/skills/` (a marker file lets `uninstall-host` tell ours from yours). Copies, not links: older Cursor builds did not follow symlinked skills (staff-confirmed bug, fixed in 2.5), and copies stay safe | https://cursor.com/docs/skills ; symlink reports: https://forum.cursor.com/t/global-symlinked-skills-are-not-discovered-by-cursor/150028 | **full** in the IDE; copies go stale, so re-run `install-host` after an update. With "Sync Skills for Cloud Agents" on, Cursor moves `~/.cursor/skills` contents to synced storage and a re-run may conflict |
| Tools (MCP) | `mcpServers.<id>` entries merged into `~/.cursor/mcp.json`; a same-named entry that differs is left alone; keyed servers use `${env:NAME}` | https://cursor.com/docs/context/mcp | **full** in the IDE. Cursor CLI asks for approval first: `agent mcp enable <id>` or `--approve-mcps` (https://cursor.com/docs/cli/mcp) |
| Slash commands | none from this plugin; skills run as `/skill-name` | https://cursor.com/docs/skills | **not possible** for `/jarvis-setup` |

### What stays Claude-Code-only

- The setup page's Claude Code connections (`claude mcp add`) and the optional
  `recall` and Telegram bridge, which depend on Claude Code's hooks and CLI.
- `${CLAUDE_PLUGIN_ROOT}` in skill text. Codex and Cursor do not set it, so the
  hook and the instruction block both say which folder it means.
- `/jarvis-setup` as a slash command (the page still runs: `node setup/server.mjs`).

### Known limits

- Optional skills you enable later (`skills-materializer`) reach Codex and
  Cursor only when you run `install-host` again; it also removes links to
  skills you switched off.
- Cursor reads `~/.agents/skills` too (per its docs). If you install for both
  hosts, the same skill can appear twice in Cursor.
- A `config.toml` that defines servers with an inline `mcp_servers = { ... }`
  table is not detected; use the normal `[mcp_servers.x]` form.
- Tested against a fake home folder and by running the registered hook
  command. Codex and Cursor themselves were not run in the author's
  environment; see the changelog for the checklist to verify on a real install.

## Phone assistant (Telegram bridge)

Everything in this section is for people who want an always-on assistant
reachable from their phone over Telegram — not something most people need on
day one, and it assumes you're comfortable working in a terminal.

The default way to reach Claude Code from your phone is its own **Remote
Control** feature (`claude remote-control` + claude.ai/code on your phone) —
no bot account, no allowlist, nothing to configure. Verified against the
shipped app (2.1.245), not just the docs, so here's exactly where it stops:

- Unavailable inside a cloud session and behind an enterprise gateway.
- Files the agent sends do **not** reach phone/web viewers.
- Only the effort level and one other setting are changeable from the remote
  side.
- Needs the host computer awake with a live conversation already running —
  it's remote control of a running session, not a standalone assistant.

For more than that — a persistent assistant you can message from Telegram
any time, that survives a reboot and restarts itself — this plugin ships
`bridge/`: a background session (kept running via `tmux`, a terminal
multiplexer) plus a watchdog that keeps it both alive and *reachable* (not
the same thing — see below). **Opt-in, and not installed by anything
automatically.** Full install/uninstall instructions and every tunable:
[`bridge/README.md`](../bridge/README.md).

What you get once it's installed:

- `/new` — wrap the session up to memory and start fresh
- `/model <opus|sonnet|fable|id>`, `/effort <low|medium|high>` — switch mid-conversation
- `/compact [note]`, `/context` — manage the context window from your phone
- `/info` — model, effort, mode, uptime

**Reserved Telegram commands.** `/start`, `/help` and `/status` are
intercepted by Telegram's own connection ("channel," in Claude Code's
terms) and never reach the assistant — that's why the bridge's own status
command is `/info`, not `/status`. Don't expect those three to do anything
bridge-specific.

**The one sharp edge, stated plainly:** Telegram only allows **one** program
at a time to check for a bot's new messages. If you (or an old session you
forgot about, or a second computer) ever run **two** Claude Code sessions
connected to the same Telegram bot, Telegram silently cuts one of them off.
The loser keeps running and looks completely healthy — it's just **deaf**,
and every message that arrives while it's deaf is swallowed by the winner and
gone for good, not delayed. This is exactly the failure mode
`telegram-watchdog.sh` exists to detect and recover from (it tells you the
exact time window you were deaf, so you know what to resend) — but the safest
fix is structural: never turn on Telegram any other way, only ever start it
through `bridge/telegram-bridge.sh`. Read
[`bridge/README.md`](../bridge/README.md) and `SECURITY.md` before installing
this piece.

## Skills and licenses

Every shipped skill was checked against its **primary source** license
before inclusion — not a blog post about the license, the actual license
file.

- **Vendored as-is (MIT):** `defuddle`, `obsidian-markdown`, `obsidian-bases`,
  `json-canvas`, and `obsidian-cli` (Steph Ango / kepano, all from the same
  `kepano/obsidian-skills` source, current upstream at time of vendoring),
  and `qmd` (Tobi Lütke). The bundled `qmd` is **not current upstream** — a
  trimmed fork of v2.0.0, while `github.com/tobi/qmd` is at v2.2.0 and has
  since added a few extra features. Treat it as a known-older excerpt. The
  four Obsidian skills are optional — see [Optional skills](#optional-skills).
- **Ported and rewritten to remove anything personal**, from one person's own
  workflow skills: `done`, `memory-consolidation`, `wiki-article`, `learn`,
  `research-notebook`, `media-gen`, `playwright-cli`, `voice` (the last two
  also optional — see above).
- **Already generic, ships as-is:** `grill-me`, `eli5` (original instructions;
  credits the underlying technique to Thariq at Anthropic via a public
  write-up — see the file itself).

Evaluated and deliberately **left out**: `scroll-world` (a scroll-cinematic
video skill) has no license file traceable to any real upstream source or
author — its LICENSE file names a copyright holder with no linked project or
profile anywhere, so there's nothing to verify against. A skill this repo
can't point at a primary source for doesn't ship, no matter how good it is.

## Recommended, but install them yourself

Left out for license reasons, not quality ones:

- **`llm-council`** — a question or decision run past five independent
  advisors, peer-reviewed, then synthesized. By
  [Ole Lehmann](https://github.com/aiwithremy/claude-skills-llm-council),
  methodology credited to Andrej Karpathy. Its repo ships **no LICENSE file**,
  so there's no grant to redistribute it. This plugin's own `council` skill is
  an independent implementation of the same publicly described method, with
  none of that skill's text.
- **`nano-banana`** — image generation and editing, with a free tier. Licensed
  **AGPL-3.0**; bundling it would pull this entire plugin under that
  copyleft license.

## Non-negotiables

- **No secret is ever written into this repo, logged, or echoed back** by the
  setup page. Keys go to your own config; the page shows a masked
  confirmation only.
- **No telemetry.** Nothing about how you use this is sent anywhere.
- **The local setup page is never a background process.** One-time-code
  protected, reachable only from your own computer, and it shuts itself
  down.

## Repo layout

```
.claude-plugin/       plugin + marketplace manifests
hooks/                startup script — injects hub MEMORY.md
commands/             /jarvis-setup
setup/                the temporary local setup page + its server
  profile.json        title, steps and finish text the page renders (an edition = a different profile)
  tools-catalog.json  the Tools step: what each tool is, how to detect, install or connect it
  agent.mjs           the same setup, as commands an agent can run (see AGENTS.md)
skills/               the default-on shipped skills
optional-skills/      skills switched into skills/ on demand — see "Optional skills"
memory-template/      seed hub: MEMORY.md index + example memory files
bridge/               opt-in Telegram phone assistant — see bridge/README.md
```
