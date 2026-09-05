#!/bin/bash
# telegram-set-commands.sh — register the bridge's slash-command menu.
#
# The telegram plugin calls setMyCommands with its own commands in the
# all_private_chats scope on every start. Telegram gives a NARROWER scope
# precedence, so registering in the "chat" scope wins and survives every
# plugin restart. telegram-bridge.sh re-runs this on each launch (idempotent).
#
# /start, /help and /status are handled by the plugin itself and never reach
# the assistant — /status just answers "Paired as <id>". That's why the
# bridge's own status command is /info (see jarvisctl and CLAUDE.bridge.md).
set -u

ENVF="$HOME/.claude/channels/telegram/.env"
ACCESS_FILE="$HOME/.claude/channels/telegram/access.json"

resolve_chat_id() {
    if [ -n "${JARVIS_CHAT_ID:-}" ]; then printf '%s' "$JARVIS_CHAT_ID"; return 0; fi
    [ -f "$ACCESS_FILE" ] || return 1
    command -v python3 >/dev/null 2>&1 || return 1
    python3 - "$ACCESS_FILE" <<'PY' 2>/dev/null
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    allowed = data.get("allowFrom") or []
    if allowed:
        print(allowed[0])
except Exception:
    pass
PY
}

CHAT_ID="${1:-$(resolve_chat_id)}"
if [ -z "$CHAT_ID" ]; then
  echo "telegram-set-commands: no chat id — pass one as \$1, set JARVIS_CHAT_ID, or pair via the telegram:access skill first" >&2
  exit 1
fi

TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')
[ -n "$TOKEN" ] || { echo "telegram-set-commands: no token in $ENVF"; exit 1; }

COMMANDS='[
  {"command":"new","description":"Wrap up this session (/jarvis-os:done) and start fresh"},
  {"command":"info","description":"Model, effort, mode and uptime"},
  {"command":"model","description":"Switch model: /model opus | sonnet | fable | <id>"},
  {"command":"effort","description":"Set effort: /effort low | medium | high"},
  {"command":"compact","description":"Compress the current context in place"},
  {"command":"context","description":"Show what is filling the context window"},
  {"command":"commands","description":"List bridge commands"}
]'

curl -sS "https://api.telegram.org/bot${TOKEN}/setMyCommands" \
  -H 'Content-Type: application/json' \
  -d "{\"commands\":${COMMANDS},\"scope\":{\"type\":\"chat\",\"chat_id\":${CHAT_ID}}}" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin); print("setMyCommands:", "ok" if r.get("ok") else r)'

curl -sS "https://api.telegram.org/bot${TOKEN}/getMyCommands" \
  -H 'Content-Type: application/json' \
  -d "{\"scope\":{\"type\":\"chat\",\"chat_id\":${CHAT_ID}}}" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin); print("registered:", ", ".join("/"+c["command"] for c in r.get("result",[])) or "(none)")'
