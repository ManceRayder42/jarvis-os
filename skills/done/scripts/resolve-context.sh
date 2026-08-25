#!/usr/bin/env bash
# resolve-context.sh — gather everything /done needs, in one cheap bash call.
# Goal: shift prep work from model-tokens to bash, leaving the model to synthesize only.
#
# Single-hub model: unlike a multi-repo vault split, there is exactly one hub
# directory and it holds everything — sessions/, wiki/, patterns.md,
# conversation-log.md, CONTEXT.md. No second-repo case exists here.
#
# Output (key=value lines, easy to parse):
#   cwd, git_root, project, hub, sessions_dir, today
#   hub_is_git           — yes|no — is the hub itself a git repo
#   hub_dirty            — yes|no — any uncommitted changes anywhere in the hub
#   hub_branch/_remote/_upstream/_ahead — push state of the hub repo
#   sessions_dirty, wiki_dirty, memory_dirty — per-area dirt flags
#   other_hub_dirty       — daily-notes/ideas/research/learning/etc, if present
#   wiki_recent_count      — wiki files modified in last 24h
#   today_daily_note, last_session_note, last_session_date
#   dirty:hub:<path> <count> — every dirty top-level path in the hub
#   today_session:<path>   — existing session notes for today (idempotency)
#   commit:<hash> <msg>    — commits in the hub since last session date

set -euo pipefail

cwd="$(pwd)"
today="$(date +%Y-%m-%d)"

# --- resolve the hub --------------------------------------------------------
# Same precedence as hooks/session-start.mjs: explicit env var, then the
# pointer file the setup server writes, then the documented default.
resolve_hub() {
  if [ -n "${JARVIS_HUB:-}" ]; then printf '%s' "$JARVIS_HUB"; return; fi
  if [ -f "$HOME/.jarvis-hub-path" ]; then
    local p
    p="$(tr -d '[:space:]' < "$HOME/.jarvis-hub-path")"
    if [ -n "$p" ]; then printf '%s' "$p"; return; fi
  fi
  printf '%s' "$HOME/jarvis-hub"
}
hub="$(resolve_hub)"
hub="${hub/#\~/$HOME}"

sessions_dir="$hub/sessions"

# --- classify the project being worked on -----------------------------------
# Generic rule: if cwd is inside the hub, the project is the top-level
# directory under the hub (or "hub-root" if cwd IS the hub). Outside the hub,
# use the enclosing git repo's basename if there is one, else "external".
if [ "$cwd" = "$hub" ]; then
  project="hub-root"
elif [ "${cwd#$hub/}" != "$cwd" ]; then
  rel="${cwd#$hub/}"
  project="$(printf '%s' "${rel%%/*}" | tr '[:upper:]' '[:lower:]')"
else
  if git_root_probe="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)"; then
    project="$(basename "$git_root_probe" | tr '[:upper:]' '[:lower:]')"
  else
    project="external"
  fi
fi

if git_root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)"; then :
else git_root="(none)"
fi

# --- helpers -----------------------------------------------------------------

path_dirty() {
  git -C "$hub" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "no"; return; }
  if git -C "$hub" status --porcelain -- "$@" 2>/dev/null | grep -q .; then
    echo "yes"
  else
    echo "no"
  fi
}

push_state() {
  local branch="(none)" remote="(none)" upstream="(none)" ahead=0
  if git -C "$hub" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # symbolic-ref succeeds (with the branch name) even on an unborn branch
    # (repo just `git init`'d, zero commits) — rev-parse --abbrev-ref HEAD
    # can misbehave in that state. Only a real detached HEAD fails both.
    branch="$(git -C "$hub" symbolic-ref --short -q HEAD 2>/dev/null || echo '(detached)')"
    remote="$(git -C "$hub" remote 2>/dev/null | head -1)"
    [ -z "$remote" ] && remote="(none)"
    upstream="$(git -C "$hub" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo '(none)')"
    [ -z "$upstream" ] && upstream="(none)"
    if [ "$upstream" != "(none)" ]; then
      ahead="$(git -C "$hub" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
    fi
  fi
  echo "hub_branch=$branch"
  echo "hub_remote=$remote"
  echo "hub_upstream=$upstream"
  echo "hub_ahead=$ahead"
}

dirty_paths() {
  git -C "$hub" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  git -C "$hub" status --porcelain 2>/dev/null | awk '
    {
      p = substr($0, 4)
      i = index(p, " -> "); if (i > 0) p = substr(p, i + 4)
      gsub(/^"|"$/, "", p)
      n = index(p, "/")
      top = (n > 0) ? substr(p, 1, n) : p
      cnt[top]++
    }
    END { for (t in cnt) printf "dirty:hub:%s %d\n", t, cnt[t] }
  ' | sort
}

# --- hub git state -----------------------------------------------------------

hub_is_git="no"
if git -C "$hub" rev-parse --is-inside-work-tree >/dev/null 2>&1; then hub_is_git="yes"; fi

hub_dirty="no"
if [ "$hub_is_git" = "yes" ] && git -C "$hub" status --porcelain 2>/dev/null | grep -q .; then
  hub_dirty="yes"
fi

sessions_dirty="$(path_dirty sessions/)"
wiki_dirty="$(path_dirty wiki/)"
memory_dirty="$(path_dirty patterns.md conversation-log.md CONTEXT.md MEMORY.md)"
other_hub_dirty="$(path_dirty daily-notes/ ideas/ research/ learning/ conventions/)"

wiki_recent_count=0
if [ -d "$hub/wiki" ]; then
  wiki_recent_count=$(find "$hub/wiki" -type f -name "*.md" -mtime -1 2>/dev/null | wc -l | tr -d ' ')
fi

current_branch="(none)"
if [ "$git_root" != "(none)" ]; then
  # symbolic-ref (not rev-parse) so this also works on an unborn branch —
  # a repo that's been `git init`'d but has no commits yet, which is the
  # common state of a brand-new hub or project on a fresh install.
  current_branch="$(git -C "$cwd" symbolic-ref --short -q HEAD 2>/dev/null || echo '(detached)')"
fi

today_daily_note="(none)"
if [ -f "$hub/daily-notes/$today.md" ]; then
  today_daily_note="$hub/daily-notes/$today.md"
fi

last_session_note="(none)"
last_session_date="(none)"
if [ -d "$sessions_dir" ]; then
  latest="$(ls -1 "$sessions_dir" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}' | sort -r | head -1 || true)"
  if [ -n "$latest" ]; then
    last_session_note="$sessions_dir/$latest"
    last_session_date="$(printf '%s' "$latest" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')"
  fi
fi

today_sessions=""
if [ -d "$sessions_dir" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && today_sessions="$today_sessions
today_session:$sessions_dir/$f"
  done < <(ls -1 "$sessions_dir" 2>/dev/null | grep -E "^$today-")
fi

recent_commits=""
if [ "$last_session_date" != "(none)" ] && [ "$hub_is_git" = "yes" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && recent_commits="$recent_commits
commit:$line"
  done < <(git -C "$hub" log --oneline --since="$last_session_date 00:00" 2>/dev/null | head -20)
fi

# --- output ------------------------------------------------------------------

echo "cwd=$cwd"
echo "git_root=$git_root"
echo "project=$project"
echo "hub=$hub"
echo "sessions_dir=$sessions_dir"
echo "hub_is_git=$hub_is_git"
echo "hub_dirty=$hub_dirty"
echo "sessions_dirty=$sessions_dirty"
echo "wiki_dirty=$wiki_dirty"
echo "memory_dirty=$memory_dirty"
echo "other_hub_dirty=$other_hub_dirty"
echo "wiki_recent_count=$wiki_recent_count"
echo "current_branch=$current_branch"
echo "today_daily_note=$today_daily_note"
echo "last_session_note=$last_session_note"
echo "last_session_date=$last_session_date"
echo "today=$today"
push_state
dirty_paths
[ -n "$today_sessions" ] && printf '%s\n' "$today_sessions" | sed '/^$/d'
[ -n "$recent_commits" ] && printf '%s\n' "$recent_commits" | sed '/^$/d'
exit 0
