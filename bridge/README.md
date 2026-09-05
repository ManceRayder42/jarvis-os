# Telegram bridge (opt-in)

Turns a `claude` session into a phone-reachable assistant over Telegram, with
`/new`, `/model`, `/effort`, `/compact`, `/context` and `/info` to control it
remotely. Nothing here runs until you install it — see the main README's
"Reserved Telegram commands" and daemon-disclosure notes before you do.

**Prerequisite:** the telegram channel plugin configured with a bot token and
at least one paired chat — run the `telegram:configure` and `telegram:access`
skills first if you haven't. `tg-send.sh`/`telegram-set-commands.sh` resolve
your chat id from `~/.claude/channels/telegram/access.json` (or `$JARVIS_CHAT_ID`
if you set it) — there is no built-in default.

## What's in this directory

| File | Purpose |
|---|---|
| `telegram-bridge.sh` | Starts the one canonical bridge session in tmux |
| `telegram-watchdog.sh` | Keeps it alive **and reachable** (see below) |
| `jarvisctl` | `new / restart / model / effort / compact / context / status` |
| `cleanup-telegram.sh` | Kills stale/duplicate Telegram pollers |
| `tg-send.sh` | Plain Bot API `sendMessage` — no MCP dependency |
| `telegram-set-commands.sh` | Registers the phone-side slash menu |
| `CLAUDE.bridge.md` | Block to append to your hub's `CLAUDE.md` |
| `com.jarvis.telegram-*.plist.tmpl` | launchd templates (see below) |

## Why a watchdog at all

Telegram allows exactly **one** consumer of `getUpdates` per bot token. If a
second `claude` session ever polls the same token — another window, another
machine, a project-settings misconfiguration — Telegram silently cuts one of
them off. The loser keeps running and looks perfectly healthy; it's just
**deaf**, and every message that arrives while it's deaf is destroyed, not
queued. `telegram-watchdog.sh` is what detects that state (it can't be seen
from outside the bridge) and recovers it. Read the file's own header comment
before changing the escalation tunables below.

## Quick start (no launchd, one terminal)

```bash
bash bridge/telegram-bridge.sh
tmux attach -t jarvis      # watch it; Ctrl-b then d to detach
```

That's a session you have to keep the terminal open for. For "survives
reboot, restarts itself," install the launchd jobs below.

## Install (macOS, launchd)

1. Find your plugin's installed path. From inside a Claude Code session with
   this plugin enabled:
   ```
   echo $CLAUDE_PLUGIN_ROOT
   ```
   (Or locate it yourself: `find ~/.claude/plugins/cache -maxdepth 2 -iname 'jarvis-os'`.)

2. Copy both plist templates into `~/Library/LaunchAgents/`, substituting
   that path and your home directory:
   ```bash
   PLUGIN_ROOT="$(echo $CLAUDE_PLUGIN_ROOT)"   # from step 1
   for f in com.jarvis.telegram-bridge com.jarvis.telegram-watchdog; do
     sed -e "s#__CLAUDE_PLUGIN_ROOT__#$PLUGIN_ROOT#g" -e "s#__HOME__#$HOME#g" \
       "$PLUGIN_ROOT/bridge/$f.plist.tmpl" > "$HOME/Library/LaunchAgents/$f.plist"
   done
   ```

3. Load them:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.telegram-bridge.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.telegram-watchdog.plist
   ```

4. Append `bridge/CLAUDE.bridge.md` to your hub's `CLAUDE.md` so a running
   bridge session knows what `/new`, `/model`, etc. mean.

Check it's alive: `bash bridge/jarvisctl status`, or `tail -f ~/Library/Logs/jarvis-telegram-watchdog.log`.

## Uninstall

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.telegram-bridge.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.telegram-watchdog.plist
rm ~/Library/LaunchAgents/com.jarvis.telegram-bridge.plist ~/Library/LaunchAgents/com.jarvis.telegram-watchdog.plist
tmux kill-session -t jarvis 2>/dev/null   # if it's currently running
```

Nothing else needs cleanup: `bridge.env`, `.bridge-continue` and
`.watchdog-state` all live under `<hub>/logs/` and are inert once nothing is
scheduling these scripts.

## Tunables

Environment variables, set in the plist's `EnvironmentVariables` dict or
before an interactive run:

| Variable | Default | Meaning |
|---|---|---|
| `JARVIS_HUB` | `~/.jarvis-hub-path` pointer, else `~/jarvis-hub` | Where the bridge session runs (cwd) and stores its state |
| `JARVIS_CHAT_ID` | first entry in `access.json`'s `allowFrom` | Who `tg-send.sh`/the slash menu target |
| `JARVIS_TMUX_SESSION` | `jarvis` | tmux session name |
| `JARVIS_TELEGRAM_PLUGIN_ID` | `telegram@claude-plugins-official` | Which telegram plugin build to launch/watch |
| `WATCHDOG_KILL_RIVALS_AFTER` | `1` | Deaf strikes before killing a rival poller and reclaiming the token |
| `WATCHDOG_RESTART_AFTER` | `3` | Deaf strikes before restarting the bridge |
| `WATCHDOG_RESTART_COOLDOWN` | `1800` (seconds) | Minimum gap between bridge restarts — a restart replays the whole conversation to the model |
| `WATCHDOG_RECLAIM_TOKEN` | `1` | Set to `0` to never kill another session's telegram MCP (bridge stays deaf until that session closes instead) |

## Security note

`telegram-bridge.sh` launches `claude --permission-mode auto` because the
bridge runs unattended — a session stuck on an interactive permission prompt
never replies. Read `SECURITY.md` before installing this: it means the bridge
session can act without a per-action confirmation from you. That's a real
tradeoff, not a default to install without reading.
