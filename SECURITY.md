# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/ManceRayder42/jarvis-os/security/advisories/new)
rather than a public issue. If that isn't available to you, open an issue that
describes the *class* of problem without a working exploit, and say you'd like
a private channel.

## What this plugin does with your data

Nothing leaves your machine.

- **No telemetry, analytics, or phone-home.** Not off by default — absent.
- **No network calls** from the hook or the setup server. The only code here
  that reaches the internet is a skill you explicitly enable and invoke
  (`defuddle` fetches a URL you give it; `research-notebook` talks to
  NotebookLM; `media-gen` calls fal.ai with your own key).
- **Memory stays in your hub directory.** It is read into your own Claude Code
  session context and written back by `/done`. It is not uploaded anywhere.

## Secrets

API keys submitted through the setup page are written to `<hub>/.env` with
mode `0600`, and `.env` is added to the hub's `.gitignore` automatically.

The server **never** returns a secret in a response, writes one to a log, or
echoes one back to the page. After you save a key, the page shows only a
masked confirmation (last four characters). Only a fixed allowlist of key
names is accepted; anything else is rejected.

If you'd rather not paste a key into a page at all, set the environment
variable yourself — the skills read the environment first and fall back to
`<hub>/.env`.

## The local setup server

`/jarvis-setup` starts an HTTP server. Everything about it is designed around
one fact: **any website you visit can send requests to your localhost.** A
naive local config server is a real vulnerability, not a theoretical one.

Controls, all of them load-bearing:

- Binds `127.0.0.1` only, never `0.0.0.0`. Port `0`, so the OS assigns a free
  port and there is no predictable target.
- A one-time token is minted per launch and carried in the URL. Every request
  validates it with a **timing-safe** comparison.
- Every request also validates the `Host`/`Origin` header against the loopback
  address it bound to. Failures return `403` with an empty body.
- The page heartbeats every 3 seconds. **15 seconds without a heartbeat and
  the process exits** — closing the tab is enough to shut it down.
- Hard cap: it exits after 10 minutes regardless of activity.
- It is a child of the terminal session that launched it and dies with it. It
  never detaches, never forks, and is not registered with launchd, systemd, or
  any other supervisor.

There is no background process to find, audit, or remember to kill, because
there is no background process — for the setup server, and for the plugin as
installed by default. The exceptions are both opt-in and covered below.

## The Telegram bridge is a real background process — read this before installing it

Unlike the setup server, `bridge/telegram-bridge.sh` and
`bridge/telegram-watchdog.sh` (see `bridge/README.md`) are exactly what
SECURITY posture elsewhere on this page argues against: a long-running tmux
session and a launchd-supervised loop, installed with one command and
surviving reboots. That tradeoff is deliberate and disclosed, not hidden —
you install it yourself, nothing in this plugin turns it on for you, and
`bridge/README.md` gives the exact uninstall commands.

Two things to weigh before you do:

1. **It runs with `--permission-mode auto`.** A session waiting on an
   interactive permission prompt never replies to a Telegram message, so the
   bridge can't run in the plugin's normal confirm-before-acting mode. That
   means the bridge session can take action without a per-step confirmation
   from you, over a channel (Telegram) that isn't this terminal.
2. **Telegram allows exactly one consumer of a bot token's `getUpdates` at a
   time.** If the telegram channel plugin is ever enabled a second way on the
   same machine — a project's `.claude/settings.json`, a second bridge, a
   dev session you forgot was still open — Telegram silently cuts one of them
   off. The loser keeps running and looks healthy from the outside; it is
   simply deaf, and every message that arrives while it's deaf is consumed by
   the winner and permanently unrecoverable, not delayed. `telegram-watchdog.sh`
   detects and recovers from this (see its header comment), but the safe
   default is structural: only ever enable the telegram plugin via
   `bridge/telegram-bridge.sh`'s own launch line, never in project settings.

## Scope

This plugin runs skills inside your own Claude Code session with whatever
permissions that session has. Read a skill before you enable it — that advice
applies to every plugin, including this one.
