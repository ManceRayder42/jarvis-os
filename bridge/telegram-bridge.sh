#!/bin/bash
# telegram-bridge.sh — start the one canonical jarvis-os Telegram session, in tmux.
#
# Opt-in. Nothing in this plugin calls this script for you — you (or the
# watchdog you installed from telegram-watchdog.sh) run it. tmux is what lets
# jarvisctl drive the running session afterwards (send-keys for /compact,
# /context, the plugin's own /jarvis-os:done; capture-pane to read replies).
#
#   telegram-bridge.sh            start the session if it isn't running
#   telegram-bridge.sh --attach   print how to attach
#
# Attach to watch or type into it:  tmux attach -t <session>   (detach: Ctrl-b then d)
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="${LANG:-en_US.UTF-8}"

# --- resolve where this script (and its siblings) actually live ------------
# Prefer CLAUDE_PLUGIN_ROOT when set (e.g. invoked from inside a live plugin
# session); fall back to this script's own directory otherwise, since a
# launchd job or a bare tmux shell has no such env var. Either way BRIDGE_DIR
# ends up pointing at this same bridge/ directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BRIDGE_DIR="$PLUGIN_ROOT/bridge"

# --- resolve the hub ---------------------------------------------------------
# Same precedence as every other script in this plugin: explicit env var,
# then the pointer file /jarvis-setup writes, then the documented default.
# The claude session launched below runs WITH ITS CWD SET TO THE HUB, so the
# SessionStart hook loads MEMORY.md and every hub-relative path (sessions/,
# wiki/, bridge state) resolves the same way it does in an interactive session.
resolve_hub() {
  if [ -n "${JARVIS_HUB:-}" ]; then printf '%s' "$JARVIS_HUB"; return; fi
  if [ -f "$HOME/.jarvis-hub-path" ]; then
    local p
    p="$(tr -d '[:space:]' < "$HOME/.jarvis-hub-path")"
    if [ -n "$p" ]; then printf '%s' "$p"; return; fi
  fi
  printf '%s' "$HOME/jarvis-hub"
}
HUB="$(resolve_hub)"
HUB="${HUB/#\~/$HOME}"

# The telegram channel plugin's own coordinate. Single source of truth so it
# never needs to be typed twice (once for --channels, once for the cache path
# the watchdog reads) — see telegram-watchdog.sh.
TELEGRAM_PLUGIN_ID="${JARVIS_TELEGRAM_PLUGIN_ID:-telegram@claude-plugins-official}"

SESSION="${JARVIS_TMUX_SESSION:-jarvis}"
LOG_DIR="$HUB/logs"
LOG="$LOG_DIR/telegram-bridge.log"
ENVF="$HUB/bridge.env"
CONTINUE_FLAG="$LOG_DIR/.bridge-continue"
TOKEN_FILE="$HOME/.claude/channels/telegram/.env"

mkdir -p "$LOG_DIR"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

if [ "${1:-}" = "--attach" ]; then
  echo "tmux attach -t $SESSION    (detach with Ctrl-b then d)"
  exit 0
fi

# Optional runtime overrides written by jarvisctl: MODEL=, EFFORT=.
MODEL=""; EFFORT=""; BRIDGE_SESSION_ID=""
[ -f "$ENVF" ] && . "$ENVF"

EXTRA=""
[ -n "$MODEL" ]  && EXTRA="$EXTRA --model $MODEL"
[ -n "$EFFORT" ] && EXTRA="$EXTRA --effort $EFFORT"

# Do nothing until the bot token exists (fresh machine, telegram:configure
# never run). Not an error — Telegram is opt-in for this plugin.
if ! grep -q '^TELEGRAM_BOT_TOKEN=.\+' "$TOKEN_FILE" 2>/dev/null; then
  log "no bot token in $TOKEN_FILE — not starting (run the telegram:configure skill first)"
  exit 1
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  log "session '$SESSION' already exists — nothing to do"
  exit 0
fi

# The watchdog drops this flag when it restarts a session that only went deaf,
# so the conversation is resumed instead of wiped. Consumed once.
#
# Resume by explicit id, never --continue: --continue picks the most recent
# conversation in the hub directory, and you may also open plain dev sessions
# there, so a watchdog restart could silently resume the wrong chat. The
# bridge therefore pins its own session id in bridge.env; `jarvisctl new`
# clears it, which is what makes /new a genuinely fresh session.
# A session that never received a message writes no transcript, and `claude
# --resume <id>` on it exits 1 with "No conversation found" — which kills the
# window and costs a crash-loop cooldown. Check for the transcript first and
# fall through to a fresh session when there is nothing to resume.
TRANSCRIPT_DIR="$HOME/.claude/projects/$(printf '%s' "$HUB" | sed 's/[\/.]/-/g')"
if [ -f "$CONTINUE_FLAG" ] && [ -n "${BRIDGE_SESSION_ID:-}" ] &&
   [ -f "$TRANSCRIPT_DIR/$BRIDGE_SESSION_ID.jsonl" ]; then
  rm -f "$CONTINUE_FLAG"
  EXTRA="$EXTRA --resume $BRIDGE_SESSION_ID"
  log "resuming bridge conversation $BRIDGE_SESSION_ID (requested by the watchdog)"
else
  [ -f "$CONTINUE_FLAG" ] && [ -n "${BRIDGE_SESSION_ID:-}" ] &&
    log "no transcript for $BRIDGE_SESSION_ID — starting fresh instead of failing to resume"
  rm -f "$CONTINUE_FLAG"
  BRIDGE_SESSION_ID="$(uuidgen | tr 'A-Z' 'a-z')"
  EXTRA="$EXTRA --session-id $BRIDGE_SESSION_ID"
  touch "$ENVF"
  if grep -q '^BRIDGE_SESSION_ID=' "$ENVF" 2>/dev/null; then
    sed -i '' "s|^BRIDGE_SESSION_ID=.*|BRIDGE_SESSION_ID=$BRIDGE_SESSION_ID|" "$ENVF"
  else
    echo "BRIDGE_SESSION_ID=$BRIDGE_SESSION_ID" >> "$ENVF"
  fi
  log "starting a fresh bridge conversation $BRIDGE_SESSION_ID"
fi

# Single-owner guard, structural half.
#
# Telegram allows exactly one getUpdates consumer per bot token. If the
# telegram plugin were enabled in project settings, EVERY claude session
# opened under the hub — including a plain session you opened to edit a note
# — would spawn its own poller and steal the token from the bridge, silently
# dropping whatever the loser was holding. See SECURITY.md.
#
# So the plugin is never enabled by project settings. Only this launch line
# turns it on, via --settings, which makes the bridge the only process on the
# machine that can ever poll — as long as you never also enable it elsewhere.
PLUGIN_ON="{\"enabledPlugins\":{\"$TELEGRAM_PLUGIN_ID\":true}}"

# Clear any stale poller before claiming the token.
bash "$BRIDGE_DIR/cleanup-telegram.sh" --all >>"$LOG" 2>&1 || true

log "starting tmux session '$SESSION'${EXTRA:+ (${EXTRA# })}"
# --permission-mode auto: the bridge runs unattended over Telegram, so a
# session stuck waiting on an interactive permission prompt is a session that
# never replies. This is the plugin's own bridge, not a general recommendation
# for how you run Claude Code day to day — read SECURITY.md before enabling it.
tmux new-session -d -s "$SESSION" -x 220 -y 50 -c "$HUB" \
  "claude --permission-mode auto \
     --channels plugin:$TELEGRAM_PLUGIN_ID \
     --settings '$PLUGIN_ON'$EXTRA; \
   echo 'claude exited — the watchdog (if installed) will restart it within 15s'; sleep 20"

# Register the phone-side slash menu (chat scope beats the plugin's own list).
"$BRIDGE_DIR/telegram-set-commands.sh" >>"$LOG" 2>&1 || \
  log "slash-menu registration failed (non-fatal)"

log "bridge up: tmux attach -t $SESSION"
