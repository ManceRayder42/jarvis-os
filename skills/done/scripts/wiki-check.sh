#!/usr/bin/env bash
# wiki-check.sh — decide whether /done owes the hub's wiki an article.
#
# Reads this session's transcript (auto-located: newest .jsonl under the
# munged-cwd project dir) and emits a flat WIKI_* block on stdout.
#
# Verdicts:
#   update_owed — real file edits touched a project inside the hub, and no
#                 wiki/ article was written this session
#   up_to_date  — a wiki article was already written, or no real work landed
#                 in a hub-tracked project
#   skipped     — opt-out flag set, or no transcript found (fail open)
#
# Opt out:  DONE_SKIP_WIKI_CHECK=1  or  touch /tmp/done-skip-wiki
#
# Fails open by design: a broken detector must never block /done.

set -uo pipefail

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

emit_skipped() {
  printf 'WIKI_VERDICT=skipped\nWIKI_REASON=%s\nWIKI_PROJECT=\nWIKI_FILES=\nWIKI_EDITS=0\nWIKI_DISCOVERY=0\nWIKI_TARGET=\n' "$1"
  exit 0
}

[ "${DONE_SKIP_WIKI_CHECK:-0}" = "1" ] && emit_skipped "opt-out env"
[ -f /tmp/done-skip-wiki ] && emit_skipped "opt-out file"

# Transcript dir = cwd with '/', '_' and spaces all flattened to '-'.
munged="$(printf '%s' "$PWD" | sed 's|[/_ ]|-|g')"
tdir="$HOME/.claude/projects/$munged"

if [ ! -d "$tdir" ]; then
  parent_munged="$(printf '%s' "$(dirname "$PWD")" | sed 's|[/_ ]|-|g')"
  if [ -d "$HOME/.claude/projects/$parent_munged" ]; then
    tdir="$HOME/.claude/projects/$parent_munged"
  else
    emit_skipped "no transcript dir for $PWD"
  fi
fi

transcript="$(ls -t "$tdir"/*.jsonl 2>/dev/null | head -1)"
[ -n "$transcript" ] || emit_skipped "no .jsonl in $tdir"

python3 - "$transcript" "$HUB" <<'PY'
import json, os, sys, collections

transcript, hub = sys.argv[1], sys.argv[2]

WRITE_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}
READ_TOOLS  = {"Read", "Grep", "Glob"}

# Hub dirs that are infrastructure, not projects worth a wiki article.
INFRA = {"sessions", "wiki", "daily-notes", "ideas", "research",
         "learning", "conventions", "archive"}

def is_article(p):
    return "/wiki/" in p

def paths_from(inp):
    out = []
    if not isinstance(inp, dict):
        return out
    for k in ("file_path", "notebook_path", "path"):
        v = inp.get(k)
        if isinstance(v, str):
            out.append(v)
    for e in inp.get("edits", []) or []:
        if isinstance(e, dict) and isinstance(e.get("file_path"), str):
            out.append(e["file_path"])
    return out

edits, discovery = [], []
wiki_written = False

try:
    with open(transcript, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = rec.get("message")
            if not isinstance(msg, dict):
                continue
            for block in msg.get("content", []) or []:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                name = block.get("name", "")
                ps = paths_from(block.get("input"))
                if name in WRITE_TOOLS:
                    edits.extend(ps)
                    if any(is_article(p) for p in ps):
                        wiki_written = True
                elif name in READ_TOOLS:
                    discovery.extend(ps)
except OSError as e:
    print("WIKI_VERDICT=skipped")
    print(f"WIKI_REASON=cannot read transcript: {e}")
    print("WIKI_PROJECT=\nWIKI_FILES=\nWIKI_EDITS=0\nWIKI_DISCOVERY=0\nWIKI_TARGET=")
    sys.exit(0)

def project_of(p):
    """Map an absolute path to a hub project name, or None."""
    if not p.startswith(hub + os.sep):
        return None
    rel = p[len(hub) + 1:]
    top = rel.split(os.sep, 1)[0]
    if not top or top in INFRA or top.startswith("."):
        return None
    if not os.path.isdir(os.path.join(hub, top)):
        return None
    return top.lower()

real_edits = [p for p in edits
              if not is_article(p) and "/sessions/" not in p]
counts = collections.Counter(filter(None, (project_of(p) for p in real_edits)))
disc   = collections.Counter(filter(None, (project_of(p) for p in discovery)))

project = None
if counts:
    project = counts.most_common(1)[0][0]
elif disc and disc.most_common(1)[0][1] >= 3:
    project = disc.most_common(1)[0][0]

n_edits = sum(counts.values())
n_disc  = sum(disc.values())

if wiki_written:
    verdict, reason = "up_to_date", "wiki article already written this session"
elif project is None:
    verdict, reason = "up_to_date", "no real work landed in a hub-tracked project"
else:
    verdict, reason = "update_owed", f"{n_edits} edits in {project}, no wiki article written"

names = []
for p in real_edits:
    if project_of(p) == project:
        b = os.path.basename(p)
        if b not in names:
            names.append(b)

print(f"WIKI_VERDICT={verdict}")
print(f"WIKI_REASON={reason}")
print(f"WIKI_PROJECT={project or ''}")
print(f"WIKI_FILES={','.join(names[:12])}")
print(f"WIKI_EDITS={n_edits}")
print(f"WIKI_DISCOVERY={n_disc}")
if not project:
    target = ""
else:
    target = "wiki/%s/<topic>/<article>.md" % project
print(f"WIKI_TARGET={target}")
PY
