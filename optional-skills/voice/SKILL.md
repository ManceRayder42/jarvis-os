---
name: voice
description: Turn spoken audio into text, and text into a spoken reply, via ElevenLabs (needs an ELEVENLABS_API_KEY). Use when the user attaches a voice message or audio file and wants it transcribed, or asks for a reply as speech/audio instead of text (including sending a voice note over the Telegram bridge). Transcription degrades to a local, free fallback when no key is configured — never blocks on a missing key, just says less accurately; speaking a reply has no local fallback and fails loudly instead.
---

# Voice — speech in, speech out

Two directions, both via ElevenLabs, both with a documented fallback so a
missing API key degrades rather than breaks:

- **Speech → text**: `scripts/transcribe.sh` — ElevenLabs Scribe first, local
  `mlx-whisper` (via `uv`, no manual model download) if no key is set.
  **Apple Silicon only** for the local fallback; without a key on any other
  platform this fails with a clear message instead of guessing.
- **Text → speech**: `scripts/tts-file.sh` — ElevenLabs multilingual TTS.
  There is no local fallback for this direction (no bundled TTS engine ships
  with this plugin) — without a key, it fails loudly and tells you where to
  get one. `scripts/say-voice.sh` wraps this and sends the result straight to
  Telegram as a voice note (`sendVoice`), for use with the
  [Telegram bridge](../../bridge/README.md).

## Setup

Add `ELEVENLABS_API_KEY` via the `/jarvis-setup` page, or set it directly in
`<hub>/.env`:

```
ELEVENLABS_API_KEY=sk_...
```

Get a key at <https://elevenlabs.io/app/settings/api-keys> (free tier
available). **Without a key:** `transcribe.sh` still works on Apple Silicon
Macs (falls back to local `mlx-whisper`, needs `uv` and `ffmpeg` on `PATH`);
`tts-file.sh`/`say-voice.sh` have nothing to fall back to and will say so
plainly rather than silently doing nothing.

## Usage

```bash
"${CLAUDE_PLUGIN_ROOT}/skills/voice/scripts/transcribe.sh" recording.ogg          # auto-detect language
"${CLAUDE_PLUGIN_ROOT}/skills/voice/scripts/transcribe.sh" recording.ogg en       # force a language code
"${CLAUDE_PLUGIN_ROOT}/skills/voice/scripts/tts-file.sh" "Text to speak"          # prints the audio file path
"${CLAUDE_PLUGIN_ROOT}/skills/voice/scripts/say-voice.sh" "Text to speak"         # speaks it AND sends it as a Telegram voice note
```

(Paths above assume this skill is currently enabled — it lives at
`optional-skills/voice/` until then; see the plugin README's "Optional
skills" section for how enabling works.)

## Options

`transcribe.sh`:

| Env | Default | Meaning |
|---|---|---|
| `ELEVENLABS_STT_MODEL` | `scribe_v2` | ElevenLabs speech-to-text model |
| `MLX_WHISPER_MODEL` | `mlx-community/whisper-large-v3-turbo` | Any MLX-converted Whisper repo on Hugging Face |
| `TRANSCRIBE_BACKEND` | auto | Force `elevenlabs` or `mlx` instead of auto-selecting |

`tts-file.sh` / `say-voice.sh`:

| Env | Default | Meaning |
|---|---|---|
| `ELEVENLABS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` (ElevenLabs' public premade voice "George") | Pick your own at the [voice library](https://elevenlabs.io/app/voice-library) |
| `ELEVENLABS_MODEL_ID` | `eleven_multilingual_v2` | TTS model |
| `VOICE_MAX_CHARS` | `2500` | Truncate longer text before sending |
| `JARVIS_CHAT_ID` | first paired chat in `access.json` | Which Telegram chat `say-voice.sh` sends to |

Caches transcripts by audio hash under `~/.cache/jarvis-os/transcripts/` so
repeat runs on the same file don't re-transcribe.
