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
    <string>__CLAUDE_PLUGIN_ROOT__/skills/memory-consolidation/scripts/memory-tick.mjs</string>
  </array>
  <key>StartInterval</key><integer>7200</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>__HOME__/Library/Logs/jarvis-memory-consolidation-launch.log</string>
  <key>StandardErrorPath</key><string>__HOME__/Library/Logs/jarvis-memory-consolidation-launch.log</string>
</dict>
</plist>
```

Save the block above as `~/Library/LaunchAgents/com.jarvis.memory-consolidation.plist`,
then substitute the two placeholders in place — `sed` is easier than
hand-editing, and avoids typos in a path you'll rarely touch again:

```bash
PLUGIN_ROOT="$(echo $CLAUDE_PLUGIN_ROOT)"   # run inside a Claude Code session with this plugin enabled
PLIST=~/Library/LaunchAgents/com.jarvis.memory-consolidation.plist
sed -i '' -e "s#__CLAUDE_PLUGIN_ROOT__#$PLUGIN_ROOT#g" -e "s#__HOME__#$HOME#g" "$PLIST"
```

`CLAUDE_PLUGIN_ROOT` is only set while a plugin-enabled session is running —
`claude plugin marketplace add` doesn't move the files, so this is just the
repo's own path on disk (`find ~/.claude/plugins/cache -maxdepth 2 -iname
'jarvis-os'` finds it without a live session). launchd plists don't expand
shell variables themselves, which is why the substitution has to happen
before you load it, not inside the XML.

Logging to `~/Library/Logs/` matters, not just as a nicety: `/tmp` is cleared
by macOS, and this is the plist's own stdout/stderr only — `run-agent.mjs`
(which `memory-tick.mjs` calls internally) already logs the actual
consolidation run to `~/Library/Logs/memory-consolidation.log` for the same
reason. This plist's own log only ever has something in it if the node
process fails to start at all.

`StartInterval` of `7200` ticks every 2 hours; each tick is a near-no-op
unless a run is actually due.

Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.memory-consolidation.plist
```

Unload to stop:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.memory-consolidation.plist
```

## Linux / cron

```cron
0 */2 * * * /usr/bin/node __CLAUDE_PLUGIN_ROOT__/skills/memory-consolidation/scripts/memory-tick.mjs >> ~/.local/state/jarvis-memory-consolidation-launch.log 2>&1
```

Replace `__CLAUDE_PLUGIN_ROOT__` with the plugin's real path on disk — same
resolution as the macOS section above (`echo $CLAUDE_PLUGIN_ROOT` from a
live session, or search the plugin cache directory for it). `memory-tick.mjs`
already resolves its own hub and logs the actual run through `run-agent.mjs`
to `~/.local/state/memory-consolidation.log` on Linux — the redirect above
only catches a failure to start node at all.

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
