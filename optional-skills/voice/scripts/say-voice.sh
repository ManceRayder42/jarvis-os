#!/bin/bash
# say-voice.sh — speak text and send it as a Telegram voice note.
#
#   say-voice.sh "text"  [chat_id]
#   echo "text" | say-voice.sh - [chat_id]
#
# Goes straight to the Bot API (sendVoice), so it works from launchd jobs and
# from a session whose MCP bridge is down. ElevenLabs (via tts-file.sh) is the
# only TTS backend this package ships — there's no platform-`say` fallback
# here, so a failure is reported plainly rather than silently degrading to a
# different voice/language behavior.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TOKEN_FILE="$HOME/.claude/channels/telegram/.env"
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

CHAT_ID="${2:-$(resolve_chat_id)}"
if [ -z "$CHAT_ID" ]; then
  echo "say-voice: no chat id — pass one as \$2, set JARVIS_CHAT_ID, or pair via the telegram:access skill first" >&2
  exit 2
fi

if [ $# -ge 1 ] && [ "${1:-}" != "-" ]; then TEXT="$1"
elif [ -t 0 ]; then echo "say-voice: no text given (argument or stdin)" >&2; exit 2
else TEXT="$(cat)"; fi
[ -n "$(printf '%s' "$TEXT" | tr -d '[:space:]')" ] || { echo "say-voice: no text given" >&2; exit 2; }

TOKEN="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$TOKEN_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')"
[ -n "$TOKEN" ] || { echo "say-voice: no TELEGRAM_BOT_TOKEN in $TOKEN_FILE" >&2; exit 2; }

AUDIO="$("$SCRIPT_DIR/tts-file.sh" "$TEXT" 2>/tmp/say-voice.err)"
RC=$?
NOTES="$(cat /tmp/say-voice.err 2>/dev/null)"; rm -f /tmp/say-voice.err

if [ $RC -ne 0 ] || [ ! -s "${AUDIO:-}" ]; then
  echo "$NOTES" >&2
  echo "say-voice: tts-file.sh failed, nothing to send" >&2
  exit 1
fi
[ -n "$NOTES" ] && echo "$NOTES" >&2

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$AUDIO" 2>/dev/null | cut -d. -f1)
case "$AUDIO" in
  *.ogg) MIME="audio/ogg" ;;
  *.mp3) MIME="audio/mpeg" ;;
  *.m4a) MIME="audio/mp4" ;;
  *)     MIME="application/octet-stream" ;;
esac

RESP="$(curl -sS -X POST "https://api.telegram.org/bot${TOKEN}/sendVoice" \
  -F "chat_id=$CHAT_ID" ${DUR:+-F "duration=$DUR"} -F "voice=@$AUDIO;type=$MIME")"
CRC=$?

if [ $CRC -eq 0 ] && printf '%s' "$RESP" | grep -q '"ok":true'; then
  rm -f "$AUDIO"
  echo "sent voice (${DUR:-?}s)"
  exit 0
fi

echo "say-voice: sendVoice failed (curl=$CRC); audio kept at $AUDIO" >&2
printf '%s\n' "${RESP:-no response}" | sed "s#${TOKEN}#<redacted>#g" >&2
exit 1
