#!/bin/bash
# telegram-watchdog.sh — keeps ONE bridge session alive AND reachable.
#
# Meant to run continuously under launchd (see com.jarvis.telegram-watchdog.plist.tmpl),
# 15s per check. Opt-in — nothing installs this for you.
#
# ---------------------------------------------------------------------------
# Health, not liveness.
#
# Telegram's Bot API allows exactly ONE getUpdates consumer per bot token.
# When a second process polls the same token, Telegram cuts one consumer off
# and its MCP dies. The losing session keeps running and looks perfectly
# healthy from outside — but it is DEAF, and every message sent meanwhile is
# consumed by the rival. Telegram marks a consumed update delivered and never
# resends it, so those messages are destroyed, not delayed.
#
# A liveness-only check (is the claude process alive?) cannot see this at
# all, so it does nothing while the bridge sits deaf indefinitely with no
# notice. Worse, a naive check for "is the MCP alive" typically uses
# `pgrep -f`, which on macOS matches the ORIGINAL exec argv and never sees
# the claude CLI's rewritten process title — so that probe is a permanent
# false negative and the rogue-poller eviction never fires at all. Everything
# below matches on `ps -Ao pid=,command=` instead, the same lesson
# cleanup-telegram.sh already encodes.
#
# What this script does:
#   * ownership check — is there a telegram MCP that is a DESCENDANT of the
#     bridge? Anything else is a rival.
#   * escalation: strike 1 kills rivals and reclaims the token; strike 3
#     restarts the bridge with the conversation preserved (cooldown between
#     restarts — a restart replays the whole conversation to the model, so a
#     restart loop costs real money).
#   * notifications via tg-send.sh, which does not need the MCP.
#   * a recovery message naming the exact deaf window, because you have no
#     other way to know which messages were swallowed.
#
#   telegram-watchdog.sh            run the loop (launchd does this)
#   telegram-watchdog.sh --status   print state once, change nothing
# ---------------------------------------------------------------------------

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BRIDGE_DIR="$PLUGIN_ROOT/bridge"

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

TELEGRAM_PLUGIN_ID="${JARVIS_TELEGRAM_PLUGIN_ID:-telegram@claude-plugins-official}"
TELEGRAM_PLUGIN_NAME="${TELEGRAM_PLUGIN_ID%%@*}"
TELEGRAM_MARKETPLACE="${TELEGRAM_PLUGIN_ID#*@}"

SESSION="${JARVIS_TMUX_SESSION:-jarvis}"
LOCK="/tmp/jarvis-telegram-watchdog.lock"
# Human-readable log: ~/Library/Logs survives reboots; /tmp gets cleared by
# macOS and would silently erase the watchdog's own history right when you
# need it to diagnose a deaf stretch.
GLOG="${HOME}/Library/Logs/jarvis-telegram-watchdog.log"
STATE="$HUB/logs/.watchdog-state"
CONTINUE_FLAG="$HUB/logs/.bridge-continue"
TOKEN_FILE="$HOME/.claude/channels/telegram/.env"
# The TELEGRAM PLUGIN's own cache dir (not this plugin's) — where it tracks
# .in_use markers. Version-numbered subdirectory underneath, hence the `*`:
# a prior version of this script pinned an exact version string and silently
# stopped working the moment the plugin updated. Resolve it at runtime, never
# pin the version.
PLUGIN_CACHE="$HOME/.claude/plugins/cache/$TELEGRAM_MARKETPLACE/$TELEGRAM_PLUGIN_NAME"

CHECK_INTERVAL=15
MIN_LAUNCH_INTERVAL=300      # hard floor between bridge launches (anti-spam)
NOTIFY_COOLDOWN=3600         # at most one message per event key per hour

# Deaf strikes before each action. Rivals die on the FIRST strike: while the
# bridge is running there is no legitimate reason for a second poller to
# exist, and every check it survives it is destroying messages. Restart is
# the cautious one — it costs tokens.
KILL_RIVALS_AFTER="${WATCHDOG_KILL_RIVALS_AFTER:-1}"
RESTART_AFTER="${WATCHDOG_RESTART_AFTER:-3}"
RESTART_COOLDOWN="${WATCHDOG_RESTART_COOLDOWN:-1800}"
# Set to 0 to never touch another session's telegram MCP, at the cost of the
# bridge staying deaf until that session closes.
RECLAIM_TOKEN="${WATCHDOG_RECLAIM_TOKEN:-1}"

mkdir -p "$HUB/logs" "$(dirname "$GLOG")" 2>/dev/null
glog() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$GLOG"; }

# ---------- state ----------------------------------------------------------
get_state() { grep -m1 "^$1=" "$STATE" 2>/dev/null | cut -d= -f2-; }
set_state() {
    touch "$STATE"
    if grep -q "^$1=" "$STATE" 2>/dev/null; then
        sed -i '' "s|^$1=.*|$1=$2|" "$STATE"
    else
        echo "$1=$2" >> "$STATE"
    fi
}

notify() {  # notify <key> <text>
    local key="$1" text="$2" now stamp
    now=$(date +%s)
    stamp=$(get_state "notified:$key")
    if [ -n "$stamp" ] && [ $((now - stamp)) -lt "$NOTIFY_COOLDOWN" ]; then return 0; fi
    set_state "notified:$key" "$now"
    local out
    if ! out=$("$BRIDGE_DIR/tg-send.sh" "$text" 2>&1); then
        # Say WHY. "unreachable" would hide a missing token / missing curl
        # for a whole outage on the first run of this watchdog.
        glog "notify failed: ${out:-no output from tg-send.sh}"
    fi
}

# ---------- process discovery ----------------------------------------------
# NEVER use pgrep -f here (see the header). ps + awk, with the pattern's first
# character bracketed so the awk process can never match its own command line.
has_ancestor() {   # has_ancestor <pid> <ancestor_pid>
    local p="$1" target="$2" i=0
    while [ -n "$p" ] && [ "$p" != "1" ] && [ "$i" -lt 12 ]; do
        [ "$p" = "$target" ] && return 0
        p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
        i=$((i + 1))
    done
    return 1
}

bridge_pid() {
    ps -Ao pid=,command= | awk '/[c]laude .*--channels.*plugin:telegram/ {print $1; exit}'
}

# Every telegram MCP server on the machine, however it was started.
mcp_pids() {
    ps -Ao pid=,command= | awk '/[b]un .*telegram/ || /'"$TELEGRAM_MARKETPLACE"'\/'"$TELEGRAM_PLUGIN_NAME"'/ {print $1}'
}

api_ok() {
    local tok
    tok=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$TOKEN_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')
    [ -n "$tok" ] || return 1
    # getMe is read-only. Probing with getUpdates would itself consume — and
    # therefore destroy — your pending messages.
    curl -sS --max-time 10 "https://api.telegram.org/bot${tok}/getMe" 2>/dev/null | grep -q '"ok":true'
}

# Remove .in_use markers whose PID is dead, so the plugin's refcount stays sane.
clean_stale_inuse() {
    local d f base pid
    for d in "$PLUGIN_CACHE"/*/.in_use; do
        [ -d "$d" ] || continue
        for f in "$d"/*; do
            [ -e "$f" ] || continue
            base=$(basename "$f")
            pid=${base%%.*}
            case "$pid" in (*[!0-9]*|'') continue;; esac
            kill -0 "$pid" 2>/dev/null || { rm -f "$f"; glog "removed stale in_use marker $base"; }
        done
    done
}

start_bridge() {
    clean_stale_inuse
    glog "no bridge session — starting one"
    bash "$BRIDGE_DIR/telegram-bridge.sh" >/dev/null 2>&1
}

# ---------- one health check ------------------------------------------------
# Returns nothing; acts and logs. Split out so --status can reuse the discovery.
classify() {
    BP=$(bridge_pid)
    OWN=""; RIVALS=""
    local m
    for m in $(mcp_pids); do
        if [ -n "$BP" ] && has_ancestor "$m" "$BP"; then OWN="$OWN $m"; else RIVALS="$RIVALS $m"; fi
    done
    OWN=$(echo "$OWN" | xargs); RIVALS=$(echo "$RIVALS" | xargs)
}

if [ "${1:-}" = "--status" ]; then
    classify
    echo "tmux session : $(tmux has-session -t "$SESSION" 2>/dev/null && echo up || echo DOWN)"
    echo "bridge claude: ${BP:-DOWN}"
    echo "own mcp      : ${OWN:-NONE (deaf)}"
    echo "rival mcp    : ${RIVALS:-none}"
    echo "telegram api : $(api_ok && echo ok || echo UNREACHABLE)"
    echo "fail streak  : $(get_state fails)"
    echo "deaf since   : $(s=$(get_state deaf_since); [ -n "$s" ] && date -r "$s" '+%F %T' || echo '-')"
    echo "watchdog log : $GLOG"
    exit 0
fi

# ---------- singleton -------------------------------------------------------
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
    exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

last_launch=0
saw_healthy=0     # did the bridge actually come up since the last launch?
while true; do
    classify
    clean_stale_inuse
    [ -n "$BP" ] && saw_healthy=1

    if [ -z "$BP" ]; then
        # ---- no bridge at all: crash, logout, or first boot ----------------
        # If a tmux window survived without its claude, tear it down so the
        # next launch is clean.
        if tmux has-session -t "$SESSION" 2>/dev/null; then
            glog "tmux session up but no bridge claude — killing the stale window"
            notify bridge-dead "The bridge session had exited but its window was still open, so nothing restarted it. Fixed automatically — no action needed."
            tmux kill-session -t "$SESSION" 2>/dev/null
        fi
        now=$(date +%s)
        # The launch floor exists to stop a crash LOOP, not to delay a
        # legitimate restart. If the bridge actually came up since the last
        # launch — a deliberate `jarvisctl restart`, a watchdog restart, a
        # normal exit — relaunch at once; a long silence is the worse failure.
        if [ "$saw_healthy" = "1" ] || [ $(( now - last_launch )) -ge "$MIN_LAUNCH_INTERVAL" ]; then
            start_bridge
            last_launch=$now
            saw_healthy=0
            set_state fails 0
            sleep 30        # let it boot before re-checking
        else
            glog "bridge down but within launch cooldown ($(( MIN_LAUNCH_INTERVAL - (now - last_launch) ))s left) — waiting"
        fi

    elif [ -n "$OWN" ]; then
        # ---- healthy: the bridge owns a live telegram MCP -------------------
        deaf_since=$(get_state deaf_since)
        if [ -n "$deaf_since" ]; then
            glog "recovered — bridge mcp $OWN is live again (deaf since $(date -r "$deaf_since" '+%H:%M'))"
            # Whatever arrived while a rival held the token was consumed by it
            # and Telegram will never redeliver it. Always name the window.
            "$BRIDGE_DIR/tg-send.sh" "The bridge is back. I was deaf from $(date -r "$deaf_since" '+%H:%M') to $(date '+%H:%M'). Any message you sent in that window was swallowed and can't be recovered — please resend it." >/dev/null 2>&1 || true
            set_state deaf_since ""
        fi
        set_state fails 0

    elif ! api_ok; then
        # ---- deaf, but Telegram itself is unreachable: network blip --------
        glog "bridge $BP has no mcp, but the Telegram API is unreachable — network blip, no strike"

    else
        # ---- deaf: alive, reachable API, no MCP of its own ------------------
        fails=$(( $(get_state fails 2>/dev/null || echo 0) + 1 ))
        set_state fails "$fails"
        [ -n "$(get_state deaf_since)" ] || set_state deaf_since "$(date +%s)"
        glog "bridge $BP has no telegram mcp (DEAF) — strike $fails${RIVALS:+, rivals: $RIVALS}"

        if [ -n "$RIVALS" ] && [ "$RECLAIM_TOKEN" = "1" ] && [ "$fails" -ge "$KILL_RIVALS_AFTER" ]; then
            glog "reclaiming the bot token — stopping rival telegram mcp servers: $RIVALS"
            kill $RIVALS 2>/dev/null
            notify rival-mcp "Telegram bridge collision. Another Claude session was running the same plugin, and only one session can poll the bot token at a time — that's what silenced me. I stopped its Telegram connection; that session keeps running otherwise."
        fi

        if [ "$fails" -ge "$RESTART_AFTER" ]; then
            now=$(date +%s)
            last=$(get_state last_restart)
            if [ -n "$last" ] && [ $((now - last)) -lt "$RESTART_COOLDOWN" ]; then
                glog "still deaf, last restart $(( (now - last) / 60 ))m ago — holding off (cooldown ${RESTART_COOLDOWN}s)"
                notify restart-held "The bridge is still deaf and a restart didn't help. Not restarting again for now — every restart replays the whole conversation to the model and costs tokens, so a loop would burn them for nothing."
            else
                glog "restarting the bridge (context preserved)"
                set_state last_restart "$now"
                : > "$CONTINUE_FLAG"
                notify bridge-restart "The bridge lost its Telegram connection while the session kept running, so your messages weren't reaching me. Restarting now with the conversation preserved. Back in about a minute."
                tmux kill-session -t "$SESSION" 2>/dev/null || kill "$BP" 2>/dev/null
                set_state fails 0
                last_launch=0    # allow an immediate relaunch
            fi
        fi
    fi

    sleep "$CHECK_INTERVAL"
done
