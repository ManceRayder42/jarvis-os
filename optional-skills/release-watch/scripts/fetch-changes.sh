#!/usr/bin/env bash
# fetch-changes.sh -- what has Anthropic shipped since the last run?
# Emits JSON on stdout:
#   { "changelog": {"new_versions":[...], "latest":"X", "text":"..."},
#     "news": [{"title":"...","url":"..."}], "counts": {"versions":N,"news":M} }
# State: <hub>/release-watch/state.json  {"last_version":"","seen_news":[]}
# Exit 0 = ok (even with nothing new), 1 = fetch failure (fail loud).
# No secrets, no accounts: public URLs only.

set -euo pipefail

resolve_hub() {
  if [[ -n "${JARVIS_HUB:-}" ]]; then printf '%s' "${JARVIS_HUB/#\~/$HOME}"; return; fi
  if [[ -f "$HOME/.jarvis-hub-path" ]]; then
    local p; p="$(tr -d '\r\n' < "$HOME/.jarvis-hub-path")"
    [[ -n "$p" ]] && { printf '%s' "${p/#\~/$HOME}"; return; }
  fi
  printf '%s' "$HOME/jarvis-hub"
}

HUB="$(resolve_hub)"
STATE_DIR="$HUB/release-watch"
STATE="$STATE_DIR/state.json"
CHANGELOG_URL="https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md"
NEWS_URL="https://www.anthropic.com/news"

command -v curl >/dev/null 2>&1 || { echo "release-watch: curl required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "release-watch: python3 required" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$STATE_DIR"
[[ -f "$STATE" ]] || printf '{"last_version":"","seen_news":[]}\n' > "$STATE"

curl -sfL --max-time 60 "$CHANGELOG_URL" -o "$WORK/changelog.md" \
  || { echo "release-watch: failed to fetch changelog" >&2; exit 1; }
[[ -s "$WORK/changelog.md" ]] || { echo "release-watch: empty changelog" >&2; exit 1; }

if [[ "${RELEASE_WATCH_NEWS:-1}" != "0" ]] && curl -sfL --max-time 60 "$NEWS_URL" -o "$WORK/news.html"; then
  grep -oE '/news/[a-z0-9-]+' "$WORK/news.html" 2>/dev/null | sort -u > "$WORK/news-paths.txt" || true
else
  : > "$WORK/news-paths.txt"
fi

python3 - "$WORK/changelog.md" "$STATE" "$WORK/news-paths.txt" <<'PY'
import json, re, sys

changelog_path, state_path, news_path = sys.argv[1:4]
state = json.load(open(state_path, encoding="utf-8"))
last = state.get("last_version", "")
seen = set(state.get("seen_news", []))

text = open(changelog_path, encoding="utf-8").read()
parts = re.split(r'^##\s+(\S+)\s*$', text, flags=re.M)
sections = list(zip(parts[1::2], parts[2::2]))

new, buf = [], []
for ver, body in sections:
    if last and ver == last:
        break
    new.append(ver)
    buf.append(f"## {ver}\n{body.rstrip()}\n")
    if not last and len(new) >= 3:  # first run: newest 3 only
        break

news = []
for line in open(news_path, encoding="utf-8"):
    p = line.strip()
    if not p:
        continue
    url = "https://www.anthropic.com" + p
    if url in seen:
        continue
    news.append({"title": p.rsplit("/", 1)[-1].replace("-", " "), "url": url})
news = news[:15]

print(json.dumps({
    "changelog": {
        "new_versions": new,
        "latest": sections[0][0] if sections else "",
        "text": "\n".join(buf),
    },
    "news": news,
    "counts": {"versions": len(new), "news": len(news)},
}, ensure_ascii=False))
PY
