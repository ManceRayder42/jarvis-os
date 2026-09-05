#!/bin/bash
# cleanup-telegram.sh — clear stale Telegram pollers before/while the bridge runs.
#
# Classes of stale processes that break the bridge:
#   1. Older canonical bridge sessions (claude --channels plugin:telegram@...).
#      Duplicate launches fight for Telegram's getUpdates singleton lock
#      (409 Conflict) and steal messages. Only the NEWEST canonical session
#      survives.
#   2. Duplicate pollers owned by claude processes loading the telegram plugin
#      some other way (e.g. a desktop app window opened on the hub directory
#      with the plugin enabled in project settings — don't do that, see
#      SECURITY.md). Only their MCP child dies — never the session itself.
#   3. Orphan telegram MCP servers holding the getUpdates lock.
#
# IMPORTANT: do NOT use pgrep -f here. The claude CLI rewrites its process
# title; on macOS ps shows the live title but pgrep matches the ORIGINAL exec
# argv, so pgrep never sees "--channels plugin:telegram". All matching goes
# through ps. Patterns bracket their first char ('[c]laude') so the awk
# process never matches its own command line.
#
# Modes:
#   --all      pre-launch (telegram-bridge.sh calls this): kill EVERY
#              canonical session — the session about to launch becomes the
#              sole bridge owner.
#   (default)  manual / in-session: keep the newest canonical session alive.

set -u

kill_all=0
[ "${1:-}" = "--all" ] && kill_all=1

pids_matching() {
    ps -axo pid=,command= | awk -v pat="$1" '$0 ~ pat {print $1}'
}

# Elapsed seconds for a pid (etime "dd-hh:mm:ss" / "hh:mm:ss" / "mm:ss" → secs).
etime_secs() {
    ps -o etime= -p "$1" 2>/dev/null | awk '{
        gsub(/^ +| +$/, "")
        d = 0; t = $0
        if (split($0, dt, "-") == 2) { d = dt[1]; t = dt[2] }
        n = split(t, p, ":"); s = 0
        for (i = 1; i <= n; i++) s = s * 60 + p[i]
        print d * 86400 + s
    }'
}

# 1. Canonical sessions: --all kills every one (pre-launch); default keeps
#    only the newest and kills the rest.
canonical_pids=$(pids_matching '[c]laude .*--channels.*plugin:telegram')
newest_pid=""
if [ -n "$canonical_pids" ] && [ "$kill_all" = "1" ]; then
    echo "cleanup-telegram: pre-launch, killing ALL canonical sessions: $canonical_pids"
    kill $canonical_pids 2>/dev/null || true
    sleep 1
elif [ -n "$canonical_pids" ]; then
    newest_pid=$(for pid in $canonical_pids; do
        secs=$(etime_secs "$pid")
        [ -n "$secs" ] && echo "$secs $pid"
    done | sort -n | head -1 | awk '{print $2}')
    stale_canonical=$(echo "$canonical_pids" | grep -vw "$newest_pid" || true)
    if [ -n "$stale_canonical" ]; then
        echo "cleanup-telegram: killing stale canonical sessions (keeping newest $newest_pid): $stale_canonical"
        kill $stale_canonical 2>/dev/null || true
        sleep 1
    fi
fi

# 2. Rogue sessions (telegram plugin enabled some other way, no --channels)
#    are NOT killed. They are typically a window you're actively working in;
#    SIGTERM-ing them ends that session mid-turn. Their duplicate pollers die
#    in step 3 below, which is the actual problem.

# 3. Kill telegram MCP servers — EXCEPT the one owned by the surviving
#    canonical session (killing it mid-session breaks that session's bridge).
#    Orphans only hold the getUpdates lock; a fresh session spawns its own.
bun_pids=$(pids_matching '[b]un run.*telegram' | while read -r pid; do
    parent=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$newest_pid" ] && [ "$parent" = "$newest_pid" ]; then continue; fi
    echo "$pid"
done)
if [ -n "$bun_pids" ]; then
    echo "cleanup-telegram: killing stale telegram MCP servers: $bun_pids"
    kill $bun_pids 2>/dev/null || true
fi

exit 0
