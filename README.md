<p align="center">
  <img src="assets/jarvis-os.jpg" alt="Jarvis OS" width="180">
</p>

# Jarvis OS

A Claude Code plugin that gives a persistent memory hub to every session,
from any working directory, plus a curated set of research and workflow
skills. It's the engine behind one person's daily-driver Claude Code setup,
stripped of anything personal and rebuilt as something you can point at your
own machine.

## What this is

- A `SessionStart` hook that loads `<your hub>/MEMORY.md` into context on
  every session, regardless of which directory you launched Claude Code from.
- A one-time `/jarvis-setup` command that opens a local page to point the
  plugin at a hub directory and toggle feature sets on.
- A seed hub (`memory-template/`) showing the one-fact-per-file memory format
  with frontmatter, so you have a working example instead of a blank page.
- A `/done` command that closes out a session and folds it into memory. This
  is the one thing you have to remember to run — see
  [The one habit you have to build](#the-one-habit-you-have-to-build).

## What this is NOT

- **Not a clone of anyone's personal setup.** Nothing here is tied to one
  person's projects, vault, or preferences. What ships is the generic engine
  plus system-level defaults — you build the memory content yourself, the
  same way you'd fill in a fresh notes app.
- **Not a replacement for Claude Code's built-in project memory.** It solves
  a different problem (see "Why a hub" below) and the two coexist fine.
- **Not going to ask for a credit card in the first five minutes.** Anything
  that needs a paid API key ships toggled off by default.

## Why a hub, not Claude Code's own memory

Claude Code already has an auto-memory feature — but it's keyed to git root,
and it silently does not load when your current directory is outside a
repo it recognizes. That's not a bug you'll get an error for; it's just gone,
and you won't notice until the context you expected isn't there. The hub
sidesteps that entirely: one directory, one `MEMORY.md`, injected on every
session start no matter where you are.

## Install

```bash
claude plugin marketplace add ManceRayder42/jarvis-os
claude plugin install jarvis-os
```

Restart Claude Code (or start a new session) after installing.

From a local clone instead, point the marketplace at the checkout:

```bash
claude plugin marketplace add /path/to/your/clone
claude plugin install jarvis-os
```

## Setup

Inside Claude Code:

```
/jarvis-setup
```

This starts a short-lived local server on `127.0.0.1` (random port, one-time
token in the URL) and prints a link. Open it in your browser to:

- pick a hub directory (defaults to `~/jarvis-hub`)
- toggle feature sets (core / research / media / telegram)
- optionally point at an Obsidian vault

The server has no daemon and no background process to manage — it exits on
its own when you close the tab (or after 10 minutes idle), and it dies with
the terminal that launched it. Reopening is just `/jarvis-setup` again.

Until you run setup, the plugin stays quiet: one short line at session start
telling you it isn't configured yet, nothing more.

## The one habit you have to build

**End every working session with `/done`** — or just tell Claude to close out
the session, which triggers the same skill.

This is the only manual step, and the only change to how you already work.
Everything else in this plugin is automatic: memory loads on its own at
session start, skills fire when they're relevant, nothing else asks anything
of you.

`/done` is what makes the loop close. It writes a short session note, folds
what happened into your memory files, and commits the hub. Skip it and the
session's decisions live only in a transcript you'll never reopen — the next
session starts from the same memory as the last one, and the whole point of a
memory hub quietly stops working.

The failure mode is invisible, which is why it needs to become a habit: nothing
breaks, nothing errors, memory just silently stops growing. If you only
remember one thing from this README, make it this one.

## Obsidian — recommended, not required

Everything works with a plain directory of markdown files as your hub.
Obsidian adds a UI for browsing and linking that hub, plus wikilink-style
cross-referencing between memory files, but the plugin doesn't require it,
check for it, or degrade if it's absent.

## Remote control: Remote Control vs Telegram

The default remote path is Claude Code's own **Remote Control**
(`claude remote-control` + claude.ai/code on your phone) — no bot token, no
allowlist, no polling collision between concurrent sessions. Verified against
the shipped binary (2.1.245), not just the docs, so here's what it actually
gets you and where it stops:

- Unavailable inside a cloud session and behind an enterprise gateway.
- Files the agent sends do **not** reach phone/web viewers.
- Only `effortLevel` and `ultracode` are changeable from the remote side.
- It needs the host machine awake with a live session — it's remote control
  of a running session, not a standalone remote agent.

Telegram is supported but **opt-in**, off the critical path. It needs a
BotFather token and an allowlist, and two concurrent sessions polling the
same bot will steal each other's messages if you're not careful. The setup
page explains how to wire it up when you actually want it; it isn't the
default because most people don't need a second messaging surface just to
get started.

## Repo layout

```
.claude-plugin/plugin.json      name, description, hooks
.claude-plugin/marketplace.json single-plugin marketplace for install
hooks/session-start.mjs         inject hub MEMORY.md; first-run nudge to /jarvis-setup
commands/jarvis-setup.md        slash command -> launches setup/server.mjs
setup/server.mjs                the ephemeral local setup server
setup/page.html                 the setup page (hub path, feature toggles)
skills/                         vendored + genericized skills that cleared a license check (see below)
memory-template/                seed hub: MEMORY.md index + example memory files
config.example.json             feature toggles, hub path
LICENSE                         MIT
```

## Skills

Shipped in `skills/`, each cleared against its primary-source license before
inclusion:

- **Vendored as-is (MIT):** `defuddle` (Steph Ango / kepano, byte-identical to
  upstream) and `qmd` (Tobi Lütke). The vendored `qmd` copy is **not current
  upstream** — it's a trimmed, hand-edited fork based on v2.0.0, while
  `github.com/tobi/qmd` is at v2.2.0 as of this writing and has since added
  `--full-path`, line-slicing, `qmd doctor`, and more. Treat it as a known-older
  excerpt; check upstream if you need the newer features.
- **Ported and genericized (originally personal workflow skills, rewritten
  for a stranger's hub):** `done`, `memory-consolidation`, `wiki-article`,
  `learn`, `research-notebook`, `media-gen`.
- **Ships as-is, already generic:** `grill-me`.

`media-gen` ships under the **media** feature group (toggled off by default
in Setup, above): photoreal image/video generation and upscaling via fal.ai,
pay-per-use with your own API key. `nano-banana` is listed on the setup page
as an install-it-yourself recommendation instead of bundled — its upstream
plugin is AGPL-3.0, which this MIT-licensed plugin can't absorb, so it stays
a separate install rather than a vendored copy.

### Recommended, install yourself: LLM Council

Not vendored in this repo. `llm-council` — running a question or decision
through several independent AI advisors, peer review, and a chairman
synthesis — is a genuinely good workflow, built by **Ole Lehmann**
(`x.com/itsolelehmann`), methodology credited to **Andrej Karpathy**. Its
upstream repo (`github.com/aiwithremy/claude-skills-llm-council`) ships with
no LICENSE file and no license grant, so it can't be redistributed inside
this MIT-licensed plugin. If you want it, install it directly from the
source:

```bash
git clone https://github.com/aiwithremy/claude-skills-llm-council
# then follow that repo's own install instructions
```

## Non-negotiables

- No secret is ever written into this repo, logged, or echoed back by the
  setup server. Keys go to your own environment/config; the page shows a
  masked confirmation only.
- No telemetry of any kind.
- Model-routing and session-hygiene defaults ship as documented suggestions
  with a stated rationale — never presented as the one correct way to run
  Claude Code.

## License

MIT — see [LICENSE](LICENSE).
