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
there is no background process.

## Scope

This plugin runs skills inside your own Claude Code session with whatever
permissions that session has. Read a skill before you enable it — that advice
applies to every plugin, including this one.
