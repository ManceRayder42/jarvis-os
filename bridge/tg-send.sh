#!/bin/bash
# tg-send.sh — send a Telegram message (or document) via the raw Bot API.
#
# Why this exists: the telegram plugin's `reply` tool only exists inside an
# interactive bridge session with the plugin loaded. A launchd/cron job (the
# watchdog, a scheduled skill) runs headless with no MCP tools at all — it
# needs a plain CLI path to deliver a message. This is that path.
#
# Usage:
#   tg-send.sh "message text"
#   echo "message text" | tg-send.sh
#   tg-send.sh -c <chat_id> "message text"
#   tg-send.sh -f <file> ["caption text"]
#
# Token is read at runtime from ~/.claude/channels/telegram/.env
# (TELEGRAM_BOT_TOKEN=...). Never hardcode it here, never echo it.
#
# Chat id resolution (no hardcoded default — this plugin doesn't know your
# chat id): explicit -c flag, else $JARVIS_CHAT_ID, else the first entry in
# ~/.claude/channels/telegram/access.json's "allowFrom" list — the same file
# the telegram:access skill manages when you pair. If none of those resolve,
# this script fails loudly instead of guessing.

set -uo pipefail

ENV_FILE="$HOME/.claude/channels/telegram/.env"
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

chat_id=""
file=""

while getopts ":c:f:" opt; do
    case "$opt" in
        c) chat_id="$OPTARG" ;;
        f) file="$OPTARG" ;;
        \?) echo "Unknown option: -$OPTARG" >&2; exit 1 ;;
        :) echo "Option -$OPTARG requires an argument" >&2; exit 1 ;;
    esac
done
shift $((OPTIND - 1))

if [ -z "$chat_id" ]; then
    chat_id="$(resolve_chat_id)"
fi
if [ -z "$chat_id" ]; then
    echo "tg-send: no chat id — pass -c <chat_id>, set JARVIS_CHAT_ID, or pair via the telegram:access skill first" >&2
    exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
    echo "tg-send: token file not found at $ENV_FILE" >&2
    exit 1
fi

TELEGRAM_BOT_TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "tg-send: TELEGRAM_BOT_TOKEN not set in $ENV_FILE" >&2
    exit 1
fi

api_url="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

# Strip the token from any curl/error output before it reaches stdout/stderr.
redact() {
    sed "s#${TELEGRAM_BOT_TOKEN}#<redacted>#g"
}

if [ -n "$file" ]; then
    if [ ! -f "$file" ]; then
        echo "tg-send: file not found: $file" >&2
        exit 1
    fi
    caption="${1:-}"
    response="$(curl -s -X POST "${api_url}/sendDocument" \
        -F "chat_id=${chat_id}" \
        -F "document=@${file}" \
        -F "caption=${caption}" 2>&1 | redact)"
else
    if [ -n "${1:-}" ]; then
        text="$1"
    else
        text="$(cat)"
    fi
    response="$(curl -s -X POST "${api_url}/sendMessage" \
        --data-urlencode "chat_id=${chat_id}" \
        --data-urlencode "text=${text}" 2>&1 | redact)"
fi

ok="$(printf '%s' "$response" | grep -o '"ok":[a-z]*' | head -1 | cut -d: -f2)"

if [ "$ok" != "true" ]; then
    description="$(printf '%s' "$response" | grep -o '"description":"[^"]*"' | head -1 | cut -d: -f2-)"
    echo "tg-send: Telegram API error: ${description:-unknown error}" >&2
    exit 1
fi

exit 0
