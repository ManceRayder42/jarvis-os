#!/usr/bin/env bash
# transcribe.sh — voice -> text. ElevenLabs Scribe first, local mlx-whisper
# fallback (Apple Silicon only). Prints the transcript to stdout.
#
#   transcribe.sh <audio-file> [lang|auto] [--json] [--no-cache]
#
# Backend selection (override with TRANSCRIBE_BACKEND=elevenlabs|mlx):
#   1. ElevenLabs Scribe, if ELEVENLABS_API_KEY is set (env, or <hub>/.env).
#      Works on any platform, needs only curl + jq.
#   2. mlx-whisper, run through `uv` (no manual install — uv fetches it into
#      an ephemeral venv on first use). Apple Silicon only: mlx-whisper is
#      built on Apple's MLX framework and does not run on Intel Macs or
#      Linux/Windows. If neither is available, this script fails loudly with
#      what to install rather than guessing.
#
# Env:
#   ELEVENLABS_API_KEY     optional — enables the Scribe backend
#   ELEVENLABS_STT_MODEL   default scribe_v2
#   MLX_WHISPER_MODEL      default mlx-community/whisper-large-v3-turbo
#                          (any MLX-converted Whisper repo on Hugging Face)
#
# Cache: ~/.cache/jarvis-os/transcripts/<sha>.txt (+ .meta.json), keyed on
# audio bytes + language + backend. Skip with --no-cache.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: transcribe.sh <audio-file> [lang|auto] [--json] [--no-cache]" >&2
  exit 2
fi

AUDIO="$1"; shift
LANGCODE="auto"
JSON=0
CACHE=1

if [[ $# -gt 0 && "$1" != --* ]]; then LANGCODE="$1"; shift; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)     JSON=1 ;;
    --no-cache) CACHE=0 ;;
    *) echo "transcribe: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[[ -f "$AUDIO" ]] || { echo "transcribe: file not found: $AUDIO" >&2; exit 1; }

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

ELEVENLABS_API_KEY="${ELEVENLABS_API_KEY:-}"
if [[ -z "$ELEVENLABS_API_KEY" && -f "$HUB/.env" ]]; then
  ELEVENLABS_API_KEY="$(grep -E '^ELEVENLABS_API_KEY=' "$HUB/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
fi
ELEVENLABS_STT_MODEL="${ELEVENLABS_STT_MODEL:-scribe_v2}"
MLX_WHISPER_MODEL="${MLX_WHISPER_MODEL:-mlx-community/whisper-large-v3-turbo}"

command -v shasum >/dev/null 2>&1 || { echo "transcribe: shasum not found" >&2; exit 1; }
HAVE_JQ=0; command -v jq >/dev/null 2>&1 && HAVE_JQ=1

BACKEND="${TRANSCRIBE_BACKEND:-}"
if [[ -z "$BACKEND" ]]; then
  if [[ -n "$ELEVENLABS_API_KEY" ]]; then
    BACKEND="elevenlabs"
  elif [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
    BACKEND="mlx"
  else
    echo "transcribe: no ELEVENLABS_API_KEY set and this isn't Apple Silicon (mlx-whisper needs arm64 macOS)." >&2
    echo "transcribe: set ELEVENLABS_API_KEY (https://elevenlabs.io/app/settings/api-keys), or install a Whisper" >&2
    echo "transcribe: implementation of your own and set TRANSCRIBE_BACKEND to point this script at it." >&2
    exit 1
  fi
fi

# ---------- cache key --------------------------------------------------------
CACHE_DIR="${HOME}/.cache/jarvis-os/transcripts"
mkdir -p "$CACHE_DIR"
AUDIO_SHA="$(shasum -a 256 "$AUDIO" | awk '{print $1}')"
SHA="$(printf '%s' "${AUDIO_SHA}|lang=${LANGCODE}|backend=${BACKEND}" | shasum -a 256 | awk '{print $1}')"
CACHE_TXT="$CACHE_DIR/$SHA.txt"
CACHE_META="$CACHE_DIR/$SHA.meta.json"

emit() {  # emit <transcript> <lang> <cache_hit>
  local transcript="$1" lang="$2" cache_hit="$3"
  if [[ $JSON -eq 1 ]]; then
    if [[ $HAVE_JQ -eq 1 ]]; then
      jq -n --arg lang "$lang" --arg backend "$BACKEND" --argjson cache_hit "$cache_hit" \
        --arg transcript "$transcript" \
        '{lang:$lang, backend:$backend, cache_hit:($cache_hit==1), transcript:$transcript}'
    else
      python3 -c 'import json,sys; print(json.dumps({"lang":sys.argv[1],"backend":sys.argv[2],"cache_hit":sys.argv[3]=="1","transcript":sys.argv[4]}))' \
        "$lang" "$BACKEND" "$cache_hit" "$transcript"
    fi
  else
    printf '%s\n' "$transcript"
  fi
}

if [[ $CACHE -eq 1 && -f "$CACHE_TXT" ]]; then
  DETECTED_LANG="$LANGCODE"
  [[ -f "$CACHE_META" && $HAVE_JQ -eq 1 ]] && DETECTED_LANG="$(jq -r '.lang // "auto"' "$CACHE_META" 2>/dev/null || echo "$LANGCODE")"
  echo "[lang=$DETECTED_LANG] [backend=$BACKEND] [cache=hit]" >&2
  emit "$(cat "$CACHE_TXT")" "$DETECTED_LANG" 1
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
DETECTED_LANG="$LANGCODE"

if [[ "$BACKEND" == "elevenlabs" ]]; then
  command -v jq >/dev/null 2>&1 || { echo "transcribe: jq required for the elevenlabs backend" >&2; exit 1; }
  RESP="$WORK/scribe.json"
  ARGS=(-sS --max-time 180 -o "$RESP" -w '%{http_code}'
        -X POST "https://api.elevenlabs.io/v1/speech-to-text"
        -H "xi-api-key: $ELEVENLABS_API_KEY"
        -F "model_id=$ELEVENLABS_STT_MODEL"
        -F "file=@$AUDIO"
        -F "tag_audio_events=false")
  [[ "$LANGCODE" != "auto" ]] && ARGS+=(-F "language_code=$LANGCODE")
  HTTP="$(curl "${ARGS[@]}" 2>"$WORK/scribe.err" || echo 000)"
  if [[ "$HTTP" != "200" ]] || ! jq -e '.text // empty' "$RESP" >/dev/null 2>&1; then
    echo "transcribe: ElevenLabs Scribe failed (http=$HTTP)" >&2
    [[ -s "$RESP" ]] && head -c 300 "$RESP" >&2 && echo >&2
    exit 1
  fi
  jq -r '.text' "$RESP" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' > "$WORK/clean.txt"
  DETECTED_LANG="$(jq -r '.language_code // "auto"' "$RESP")"
  echo "[lang=$DETECTED_LANG] [backend=elevenlabs] [cache=miss]" >&2

else  # mlx
  command -v uv >/dev/null 2>&1 || {
    echo "transcribe: uv not found — install it (https://docs.astral.sh/uv/) to run the mlx-whisper fallback" >&2
    exit 1
  }
  command -v ffmpeg >/dev/null 2>&1 || {
    echo "transcribe: ffmpeg not found — mlx-whisper needs it to decode audio (brew install ffmpeg)" >&2
    exit 1
  }
  LANG_ARGS=()
  [[ "$LANGCODE" != "auto" ]] && LANG_ARGS=(--language "$LANGCODE")
  if ! uv run --with mlx-whisper -- mlx_whisper "$AUDIO" \
        --model "$MLX_WHISPER_MODEL" --output-dir "$WORK" --output-format txt \
        "${LANG_ARGS[@]}" >"$WORK/mlx.log" 2>&1; then
    echo "transcribe: mlx_whisper failed:" >&2
    cat "$WORK/mlx.log" >&2
    exit 1
  fi
  OUT_TXT="$(ls "$WORK"/*.txt 2>/dev/null | head -1 || true)"
  [[ -n "$OUT_TXT" && -f "$OUT_TXT" ]] || { echo "transcribe: mlx_whisper produced no output" >&2; exit 1; }
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$OUT_TXT" > "$WORK/clean.txt"
  echo "[lang=${LANGCODE}] [backend=mlx model=$MLX_WHISPER_MODEL] [cache=miss]" >&2
fi

TRANSCRIPT="$(cat "$WORK/clean.txt")"

# A transcript with no letters or digits (empty, or just punctuation) usually
# means the run failed even though the tool exited 0. Caching that makes the
# failure permanent and silent — warn and skip the cache write instead.
# Measuring survivors after stripping whitespace/punctuation (not [:alnum:])
# is locale-independent, so it counts Hebrew and other non-Latin scripts the
# same as English instead of rejecting them.
if [[ "$(printf '%s' "$TRANSCRIPT" | tr -d '[:space:][:punct:]' | wc -c | tr -d ' ')" -lt 2 ]]; then
  echo "transcribe: WARNING — transcript has no readable content. Not caching. If the audio isn't silent, retry with an explicit language code." >&2
  emit "$TRANSCRIPT" "$DETECTED_LANG" 0
  exit 0
fi

if [[ $CACHE -eq 1 ]]; then
  cp "$WORK/clean.txt" "$CACHE_TXT"
  if [[ $HAVE_JQ -eq 1 ]]; then
    jq -n --arg lang "$DETECTED_LANG" --arg backend "$BACKEND" '{lang:$lang, backend:$backend}' > "$CACHE_META"
  fi
fi

emit "$TRANSCRIPT" "$DETECTED_LANG" 0
