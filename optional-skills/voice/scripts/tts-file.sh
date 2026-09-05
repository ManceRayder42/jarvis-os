#!/bin/bash
# tts-file.sh — text -> speech audio via ElevenLabs. Prints the file path.
#
#   tts-file.sh "text to speak"        or        echo "text" | tts-file.sh
#
# ElevenLabs' multilingual model is the reason this exists rather than a
# platform TTS command: it handles Hebrew, English and dozens of other
# languages in one clip, where e.g. macOS `say` has no Hebrew voice at all.
#
# Env, read from <hub>/.env unless already set in the environment:
#   ELEVENLABS_API_KEY   required
#   ELEVENLABS_VOICE_ID  default JBFqnCBsd6RMkjVDRZzb (ElevenLabs' public
#                         premade voice "George" — pick your own at
#                         https://elevenlabs.io/app/voice-library)
#   ELEVENLABS_MODEL_ID  default eleven_multilingual_v2
#   VOICE_MAX_CHARS      default 2500
#   VOICE_KEEP_MP3       1 keeps the intermediate mp3 next to the ogg
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

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
ENV_FILE="$HUB/.env"
OUT_DIR="$HUB/logs/voice"
mkdir -p "$OUT_DIR"

# Environment wins over <hub>/.env.
_K="${ELEVENLABS_API_KEY:-}"; _V="${ELEVENLABS_VOICE_ID:-}"; _M="${ELEVENLABS_MODEL_ID:-}"; _C="${VOICE_MAX_CHARS:-}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
[ -n "$_K" ] && ELEVENLABS_API_KEY="$_K"
[ -n "$_V" ] && ELEVENLABS_VOICE_ID="$_V"
[ -n "$_M" ] && ELEVENLABS_MODEL_ID="$_M"
[ -n "$_C" ] && VOICE_MAX_CHARS="$_C"
ELEVENLABS_API_KEY="${ELEVENLABS_API_KEY:-}"
ELEVENLABS_VOICE_ID="${ELEVENLABS_VOICE_ID:-JBFqnCBsd6RMkjVDRZzb}"
ELEVENLABS_MODEL_ID="${ELEVENLABS_MODEL_ID:-eleven_multilingual_v2}"
VOICE_MAX_CHARS="${VOICE_MAX_CHARS:-2500}"

if [ -z "$ELEVENLABS_API_KEY" ]; then
  echo "tts-file: ELEVENLABS_API_KEY is empty — add it to $ENV_FILE (https://elevenlabs.io/app/settings/api-keys)" >&2
  exit 2
fi
command -v jq >/dev/null 2>&1 || { echo "tts-file: jq not found (brew install jq)" >&2; exit 2; }

if [ $# -ge 1 ] && [ "${1:-}" != "-" ]; then TEXT="$1"
elif [ -t 0 ]; then echo "tts-file: no text given (argument or stdin)" >&2; exit 2
else TEXT="$(cat)"; fi
TEXT="$(printf '%s' "$TEXT" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
[ -n "$TEXT" ] || { echo "tts-file: no text given" >&2; exit 2; }

NCHARS=$(printf '%s' "$TEXT" | wc -m | tr -d ' ')
if [ "$NCHARS" -gt "$VOICE_MAX_CHARS" ]; then
  TEXT="$(printf '%s' "$TEXT" | cut -c1-"$VOICE_MAX_CHARS")"
  echo "tts-file: text truncated from $NCHARS to $VOICE_MAX_CHARS chars" >&2
fi

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
MP3="$OUT_DIR/tts-$STAMP.mp3"
OGG="$OUT_DIR/tts-$STAMP.ogg"

PAYLOAD=$(jq -n --arg t "$TEXT" --arg m "$ELEVENLABS_MODEL_ID" '{text:$t, model_id:$m}')
HTTP=$(curl -sS -o "$MP3" -w '%{http_code}' \
  -X POST "https://api.elevenlabs.io/v1/text-to-speech/$ELEVENLABS_VOICE_ID?output_format=mp3_44100_128" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: audio/mpeg" \
  --data-binary "$PAYLOAD")
RC=$?

if [ $RC -ne 0 ] || [ "$HTTP" != "200" ] || [ ! -s "$MP3" ]; then
  echo "tts-file: ElevenLabs request failed (curl=$RC http=$HTTP)" >&2
  [ -s "$MP3" ] && head -c 500 "$MP3" >&2 && echo >&2
  rm -f "$MP3"
  exit 1
fi

# ogg/opus is what Telegram renders as a real voice bubble; mp3 arrives as a
# plain file attachment instead.
if command -v ffmpeg >/dev/null 2>&1 &&
   ffmpeg -hide_banner -loglevel error -y -i "$MP3" -vn -ac 1 -ar 48000 -c:a libopus -b:a 64k -application voip "$OGG" 2>/dev/null &&
   [ -s "$OGG" ]; then
  [ "${VOICE_KEEP_MP3:-0}" = "1" ] || rm -f "$MP3"
  echo "$OGG"
else
  echo "tts-file: ffmpeg conversion failed, returning mp3" >&2
  rm -f "$OGG"
  echo "$MP3"
fi
