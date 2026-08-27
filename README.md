<p align="center">
  <img src="assets/jarvis-os.jpg" alt="Jarvis OS" width="160">
</p>

<h1 align="center">Jarvis OS</h1>

<p align="center">
  <b>Claude Code forgets you between sessions. This fixes that.</b><br>
  A memory hub that loads from <i>any</i> directory, plus 9 skills that keep it fed.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green.svg"></a>
  <img alt="9 skills" src="https://img.shields.io/badge/skills-9-blue.svg">
  <img alt="API keys required: 0" src="https://img.shields.io/badge/API%20keys%20required-0-brightgreen.svg">
  <img alt="Telemetry: none" src="https://img.shields.io/badge/telemetry-none-lightgrey.svg">
  <a href="https://github.com/ManceRayder42/jarvis-os/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/ManceRayder42/jarvis-os?style=flat"></a>
</p>

```bash
claude plugin marketplace add ManceRayder42/jarvis-os
claude plugin install jarvis-os
```

Restart Claude Code, run `/jarvis-setup`, done.

<p align="center">
  <img src="assets/setup.png" alt="The /jarvis-setup page: feature toggles, hub directory, and what each skill does" width="760">
</p>

---

## The problem this solves

Claude Code already has memory. It's keyed to **git root**, and it silently
does not load when your working directory isn't in a repo it recognizes.

There's no error. No warning. The context you expected just isn't there, and
you don't find out until you're halfway through explaining something for the
fourth time.

Jarvis OS sidesteps it: **one hub directory, one `MEMORY.md`, injected at every
session start regardless of where you launched from.** A `SessionStart` hook
does it, it takes milliseconds, and it exits silently on any error — a memory
layer that breaks your session start is worse than no memory layer.

## What you get

| | |
|---|---|
| **Memory that persists** | One hub dir, loaded into every session from anywhere on disk |
| **`/done`** | Closes a session: writes a note, folds it into memory, commits the hub |
| **`/grill-me`** | Interviews you about a plan until it actually holds together |
| **`wiki-article`** | Turns a discovery session into a reference article instead of scrollback |
| **`learn`** | Book and course notes into a structured, dated learning log |
| **`defuddle`** | Any web page → clean markdown, locally |
| **`qmd`** | Hybrid search (keyword + embeddings) over your own notes |
| **`research-notebook`** | Multi-source research with citations, via NotebookLM |
| **`memory-consolidation`** | Folds recent session logs into memory so patterns persist |
| **`media-gen`** | Image/video generation via fal.ai — **off by default**, needs your own key |

Core and research skills run locally and need **no account and no API key**.
Anything that costs money ships toggled off. A free plugin shouldn't ask for a
credit card in the first five minutes.

## The one habit you have to build

**End every working session with `/done`** — or just tell Claude to close out
the session, which triggers the same skill.

This is the only manual step, and the only change to how you already work.
Everything else is automatic: memory loads on its own, skills fire when
they're relevant, nothing else asks anything of you.

`/done` is what closes the loop. Skip it and the session's decisions live only
in a transcript you'll never reopen — the next session starts from the same
memory as the last one.

The failure mode is invisible, which is exactly why it has to become a habit:
nothing breaks, nothing errors, memory just quietly stops growing. **If you
remember one thing from this README, make it this one.**

## Setup

```
/jarvis-setup
```

Opens a short-lived local server on `127.0.0.1` (random port, one-time token
in the URL) and prints a link. In the browser you pick a hub directory
(defaults to `~/jarvis-hub`), toggle feature groups, and optionally point at
an Obsidian vault. The hub is created and seeded with a starter `MEMORY.md`
on save.

**There is no daemon.** The server exits when you close the tab (15s grace),
hard-stops after 10 minutes idle, and dies with the terminal that launched it.
It's a child process of your session, not something you have to remember to
kill. Reopening is just `/jarvis-setup` again.

Until you run setup, the plugin stays quiet — one line at session start saying
it isn't configured, nothing more.

**Obsidian is recommended, not required.** Everything works with a plain
directory of markdown files. Obsidian adds browsing and wikilinks on top; the
plugin never checks for it and doesn't degrade without it.

## What this is NOT

- **Not a clone of anyone's personal setup.** Nothing here is tied to one
  person's projects, vault, or preferences. What ships is the generic engine
  plus system-level defaults — you fill in the memory yourself.
- **Not a replacement for Claude Code's project memory.** Different problem,
  and the two coexist fine.
- **Not opinionated about how you work.** Model-routing and session-hygiene
  defaults ship as documented suggestions with a stated rationale, never as
  the one correct way.

## Reaching it from your phone

The default remote path is Claude Code's own **Remote Control**
(`claude remote-control` + claude.ai/code on your phone). No bot token, no
allowlist, nothing to configure.

Verified against the shipped binary (2.1.245), not the docs — so here's where
it actually stops:

- Unavailable inside a cloud session and behind an enterprise gateway.
- Files the agent sends do **not** reach phone/web viewers.
- Only `effortLevel` and `ultracode` are changeable from the remote side.
- Needs the host awake with a live session. It's remote control of a running
  session, not a standalone remote agent.

A Telegram bridge is supported but **opt-in and off the critical path** — it
needs a BotFather token and an allowlist, and two concurrent sessions polling
the same bot will steal each other's messages. The setup page explains how to
wire it when you want it.

## Skills and licenses

Every shipped skill was checked against its **primary source** license before
inclusion — not a blog post about the license, the actual LICENSE file.

- **Vendored as-is (MIT):** `defuddle` (Steph Ango / kepano, byte-identical to
  upstream) and `qmd` (Tobi Lütke). The bundled `qmd` is **not current
  upstream** — a trimmed fork of v2.0.0, while `github.com/tobi/qmd` is at
  v2.2.0 and has since added `--full-path`, line-slicing and `qmd doctor`.
  Treat it as a known-older excerpt.
- **Ported and genericized** from personal workflow skills, rewritten for a
  stranger's hub: `done`, `memory-consolidation`, `wiki-article`, `learn`,
  `research-notebook`, `media-gen`.
- **Already generic, ships as-is:** `grill-me`.

### Recommended, but install them yourself

Left out for license reasons, not quality ones:

- **`llm-council`** — a question or decision run past five independent
  advisors, peer-reviewed, then synthesized. By
  [Ole Lehmann](https://github.com/aiwithremy/claude-skills-llm-council),
  methodology credited to Andrej Karpathy. Its repo ships **no LICENSE file**,
  so there's no grant to redistribute it.
- **`nano-banana`** — image generation and editing, with a free tier. Licensed
  **AGPL-3.0**; bundling it would pull this entire plugin under AGPL.

## Non-negotiables

- **No secret is ever written into this repo, logged, or echoed back** by the
  setup server. Keys go to your own config; the page shows a masked
  confirmation only.
- **No telemetry.** Nothing is sent anywhere.
- **The local server is never a background process.** Token-authenticated,
  loopback-only, and it kills itself.

## Repo layout

```
.claude-plugin/       plugin + marketplace manifests
hooks/                SessionStart hook — injects hub MEMORY.md
commands/             /jarvis-setup
setup/                the ephemeral local server + its page
skills/               the 9 shipped skills
memory-template/      seed hub: MEMORY.md index + example memory files
```

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security
matters are in [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
