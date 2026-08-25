# Scheduling memory-consolidation (opt-in)

This plugin never installs a background job on its own — the SPEC for this
repo rules that out explicitly, and it matches the "no telemetry, no
surprises" posture everywhere else. If you want consolidation to run
automatically, wire it up yourself using one of the snippets below. Nothing
below runs until you install it.

`scripts/memory-tick.mjs` is the scheduler front-end: it decides *whether*
today's run is needed (already succeeded today? machine offline?) and, if
so, spawns `claude -p` with a window derived from the last successful run —
not a hardcoded 24h — so a machine that was asleep for a few days catches up
in one run instead of losing the gap. See the comment header in that file
for the full reasoning.

## macOS — launchd

Create `~/Library/LaunchAgents/com.jarvis.memory-consolidation.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jarvis.memory-consolidation</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/path/to/jarvis-plugin/skills/memory-consolidation/scripts/memory-tick.mjs</string>
  </array>
  <key>StartInterval</key><integer>7200</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/jarvis-memory-consolidation.log</string>
  <key>StandardErrorPath</key><string>/tmp/jarvis-memory-consolidation.log</string>
</dict>
</plist>
```

Replace `/path/to/jarvis-plugin` with wherever this plugin is actually
checked out (`claude plugin marketplace add` doesn't move the files, so this
is the repo's own path on disk). `StartInterval` of `7200` ticks every 2
hours; each tick is a near-no-op unless a run is actually due.

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.jarvis.memory-consolidation.plist
```

Unload to stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.jarvis.memory-consolidation.plist
```

## Linux / cron

```cron
0 */2 * * * /usr/bin/node /path/to/jarvis-plugin/skills/memory-consolidation/scripts/memory-tick.mjs >> ~/.local/state/jarvis-memory-consolidation.log 2>&1
```

`memory-tick.mjs` skips the macOS-only `caffeinate` wrap automatically on
Linux — cron itself doesn't run while the machine is fully off, same
catch-up-on-next-tick behavior applies.

## Environment

Both snippets need `JARVIS_HUB` set (or `~/.jarvis-hub-path` populated by
`/jarvis-setup`) so the scheduler and the skill agree on which hub to
consolidate into — launchd and cron jobs don't inherit your shell profile,
so don't assume an env var you only set in `.zshrc` will be visible here.
Set it explicitly in the plist's `EnvironmentVariables` dict, or in a
one-line `export` at the top of a wrapper script cron calls instead of the
node binary directly.

## Uninstalling

Unload/remove the plist or crontab line. `scripts/memory-tick.mjs` and its
state file (`<hub>/.consolidation-state.json`) are inert without a scheduler
calling them — deleting the schedule entry is enough, no other cleanup
needed.
