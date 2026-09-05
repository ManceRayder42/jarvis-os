# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] — Unreleased

### Added

- **Telegram bridge (`bridge/`), opt-in.** Turns a `claude` session into a
  phone-reachable assistant: `telegram-bridge.sh` (tmux-hosted session,
  single-owner token guard), `telegram-watchdog.sh` (health — not just
  liveness — checker with a rival-poller reclaim and deaf-bridge recovery
  ladder), `jarvisctl` (`new/restart/model/effort/compact/context/status`),
  `tg-send.sh` (plain Bot API sendMessage, no MCP dependency),
  `telegram-set-commands.sh` (chat-scoped slash menu), launchd `.plist.tmpl`
  templates, `CLAUDE.bridge.md` (the block a hub's `CLAUDE.md` needs to route
  bridge commands), and `bridge/README.md` covering install, uninstall, and
  every tunable.
- **Voice (`optional-skills/voice/`), opt-in.** `tts-file.sh` (ElevenLabs → ogg/opus, default
  voice is ElevenLabs' public premade "George"), `say-voice.sh` (→ Telegram
  `sendVoice`), and `transcribe.sh` (ElevenLabs Scribe first, falling back to
  local `mlx-whisper` via `uv` on Apple Silicon — no manual model download).
- **`/done` now versions a fresh hub automatically.** `commit-hub.sh` used to
  exit silently (`nothing:hub`) forever if the hub wasn't already a git repo.
  It now runs `git init` the first time there's something real to commit, and
  reports a clear, actionable error if git identity (`user.name`/`user.email`)
  was never configured, instead of surfacing git's raw "Author identity
  unknown" failure.
- **One-time placeholder cleanup in `commit-hub.sh`.** The first time a
  session has real content to commit, the seeded `example-*.md` placeholders
  from `memory-template/` (and their index lines in `MEMORY.md`) are removed
  automatically, narrowly guarded so a file you've genuinely repurposed under
  the same name is never touched.
- **Four new skills:** `eli5` and `playwright-cli` (both Or's own work, ship
  default-on and default-off respectively — see below), and `obsidian-markdown`
  / `obsidian-bases` / `json-canvas` (vendored MIT from `kepano/obsidian-skills`,
  the same upstream `defuddle` comes from).
- **A real optional-skills gating mechanism** (`optional-skills/` +
  `setup/skills-materializer.mjs`), because a config flag alone can't hide a
  skill from Claude Code — it loads every directory under `skills/`
  regardless. `playwright-cli`, `obsidian-markdown`, `obsidian-bases`, and
  `json-canvas` ship under `optional-skills/<id>/` and are symlinked into
  `skills/<id>` only when enabled (setup page toggle, or
  `node setup/skills-materializer.mjs enable <id>` from a terminal) — falls
  back to a real copy on a filesystem that refuses symlinks. Verified against
  the actual Claude Code plugin/skill loader (2.1.261): a symlinked skill
  directory is discovered exactly like a real one, both via `--plugin-dir`
  and inside an already-installed plugin's cache directory.
- `CHANGELOG.md` (this file).

- **A setup page built as one screen instead of a form.** The plugin's emblem
  is the interface: it reports state, and pressing it runs the whole install.
  Six things orbit it — your Mac, memory, abilities, notes, phone, voice —
  each one word and a status dot, opening on click. 29 words visible on first
  paint, no scrolling, and no field to fill in on the default path. Written
  for someone who has never heard of git: no jargon on screen, every technical
  term available behind a disclosure. Zero network requests — the emblem and
  the moving backdrop are inlined.
- **`POST /api/setup-all`** — the entire install behind one press: creates and
  seeds the memory folder, starts its history, sets an author on that folder,
  finds Obsidian, switches on the default skills, and re-checks the machine.
  Every step is idempotent and reported separately, so one failure never
  aborts the rest.
- **`POST /api/install-tool`** — installs bun, tmux, ffmpeg or Obsidian through
  Homebrew on an explicit click, from a fixed allowlist; falls back to a
  copyable command when Homebrew is absent.
- **`POST /api/telegram-token`** — stores a bot token where the official
  Telegram plugin reads it (`~/.claude/channels/telegram/.env`, mode 600).
  Telling a non-technical user to run `/telegram:configure` in a terminal was
  a wall; the token is one line in one file. Pairing still belongs to
  `/telegram:access`, and this never touches `access.json`.

### Changed

- **git is no longer required.** The memory is a folder of plain text files
  and works without it; git only adds a history, and only `/done` uses it.
  Preflight marks it optional, and the one-press setup skips the history step
  with a note instead of failing when git is absent.
- **Not macOS-only.** Package suggestions, the one-click installer, browser
  opening and Obsidian detection now resolve per platform (Homebrew on macOS,
  winget on Windows, apt/dnf shown as a copyable line on Linux because a web
  page must never invoke `sudo` on someone's behalf). The Telegram bridge's
  launchd files remain macOS-specific and are labelled as such.

- **`setup/server.mjs`/`setup/page.html`** (a parallel pass over this same
  release): a 180s first-heartbeat grace period before the normal 15s idle
  timeout applies (the agent-to-human round trip of printing a URL and
  waiting for a browser tab routinely exceeds 15s); an Obsidian vault symlink
  (`<vault>/Jarvis` → the hub) so `obsidian_vault` actually does something;
  an "Auto-ELI5" toggle that writes/removes a `rules/auto-eli5.md` feedback
  rule and its `MEMORY.md` index line; a `/api/preflight` check (git, git
  identity, the `claude` CLI version, bun/tmux/ffmpeg) surfaced with exact
  fix commands instead of failing silently later; one-click `/api/git-init`
  and `/api/telegram-install` endpoints; and a `/api/telegram-status`
  read-only view of pairing state so setup can walk a user through pairing
  without a terminal. `ELEVENLABS_API_KEY` joined `FAL_KEY` in the secrets
  the setup page will write to `<hub>/.env`; `TELEGRAM_BOT_TOKEN` was
  deliberately removed from that list — the real Telegram bridge reads its
  token from `~/.claude/channels/telegram/.env` via `telegram:configure`,
  and a second copy in `<hub>/.env` would just be an unread, driftable
  duplicate.
- `skills/memory-consolidation/references/scheduling.md`'s launchd plist
  template now logs to `~/Library/Logs/` instead of `/tmp` (which macOS
  clears) and resolves the plugin's script path via a `__CLAUDE_PLUGIN_ROOT__`
  placeholder instead of a hand-edited `/path/to/jarvis-plugin` string. The
  Linux/cron snippet got the same placeholder treatment.
- README/SECURITY.md's "no daemon" claim is now scoped correctly: no daemon
  **by default** (the setup server still isn't one). The Telegram bridge and
  the memory-consolidation scheduler *are* real background processes once you
  opt into them — both docs now say so plainly, with install/uninstall
  instructions, instead of leaving the earlier absolute claim technically
  wrong the moment either is installed.

### Fixed

- Deleted stray untracked `skills/*/scripts/__pycache__/*.pyc` files (already
  gitignored, but shouldn't have been generated into a distributed skill
  directory to begin with).

[0.2.0]: https://github.com/ManceRayder42/jarvis-os/compare/v0.1.0...HEAD

## [0.1.0]

Initial public release: memory hub, `SessionStart` hook, `/jarvis-setup`, and
the first set of vendored/ported skills.
