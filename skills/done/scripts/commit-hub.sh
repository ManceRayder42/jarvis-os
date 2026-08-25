#!/usr/bin/env bash
# commit-hub.sh — stage + commit (+ conditionally push) the hub.
#
# Why a script: resolve-context.sh snapshots dirt at step 1, but /done then
# WRITES the session note, the wiki article, patterns.md and CONTEXT.md. By
# the commit step that snapshot is stale, so a model staging "the dirty
# paths" from memory reliably missed whatever it had just created. This
# re-reads git state at commit time and stages a fixed allowlist, so nothing
# written this run can be left behind.
#
# Single-hub model: one repo, no --vault flag, no second-repo branching.
#
# Usage:
#   commit-hub.sh --slug "<kebab-slug>" [--dry-run]
#
# Output (parse these — they're the report for the confirmation step):
#   committed:hub <hash> <n> files
#   nothing:hub
#   pushed:hub <branch> -> <remote>
#   nopush:hub <reason>
#   error:hub <message>
#
# Never stages a top-level file that looks user-curated and isn't part of
# what /done owns (see HUB_PATHS below). Never force-adds gitignored paths.

set -uo pipefail

# JARVIS_HUB_TEST_DIR exists so this script can be exercised against a
# throwaway directory in tests; the skill itself relies on the normal
# resolution order below.
resolve_hub() {
  if [ -n "${JARVIS_HUB_TEST_DIR:-}" ]; then printf '%s' "$JARVIS_HUB_TEST_DIR"; return; fi
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

TODAY="$(date +%Y-%m-%d)"
TRAILER="Co-Authored-By: Claude <noreply@anthropic.com>"

slug=""
dry=0

while [ $# -gt 0 ]; do
  case "$1" in
    --slug)    slug="${2:-}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) echo "error:args unknown argument: $1"; exit 2 ;;
  esac
done

[ -n "$slug" ] || { echo "error:args --slug is required"; exit 2; }

# What /done is allowed to stage. Deliberately excludes MEMORY.md and any
# user_*/project_*/feedback_*/reference_* memory file — those are hand-curated
# by the user, same reasoning as never touching CLAUDE.md in a code repo.
HUB_PATHS="sessions wiki patterns.md conversation-log.md CONTEXT.md daily-notes ideas research learning"

git -C "$hub" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "nothing:hub"; exit 0; }

# Refuse to act inside an unfinished operation — a half-rebased hub is the
# user's call to resolve, not something to bury under an automated commit.
gitdir="$(git -C "$hub" rev-parse --git-dir 2>/dev/null)"
case "$gitdir" in /*) : ;; *) gitdir="$hub/$gitdir" ;; esac
if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ] || [ -f "$gitdir/MERGE_HEAD" ]; then
  echo "error:hub repo mid-rebase/merge — commit skipped"; exit 0
fi

existing=()
for p in $HUB_PATHS; do
  [ -e "$hub/$p" ] || continue
  git -C "$hub" check-ignore -q "$p" 2>/dev/null && continue
  existing+=("$p")
done
[ ${#existing[@]} -gt 0 ] || { echo "nothing:hub"; exit 0; }

if [ "$dry" = "1" ]; then
  staged="$(git -C "$hub" add --dry-run -- "${existing[@]}" 2>/dev/null | wc -l | tr -d ' ')"
  git -C "$hub" add --dry-run -- "${existing[@]}" 2>/dev/null | sed 's/^/dryrun:hub /'
  echo "dryrun-total:hub $staged files would be staged"
  exit 0
fi

git -C "$hub" add -- "${existing[@]}" 2>/dev/null

if git -C "$hub" diff --cached --quiet 2>/dev/null; then
  echo "nothing:hub"; exit 0
fi

n="$(git -C "$hub" diff --cached --name-only | wc -l | tr -d ' ')"

if git -C "$hub" commit -q -F - <<EOF
docs(hub): session note $TODAY — $slug

$TRAILER
EOF
then
  echo "committed:hub $(git -C "$hub" rev-parse --short HEAD) ${n} files"
else
  echo "error:hub commit failed"
  exit 0
fi

# --- push --------------------------------------------------------------------
# The hub holds personal memory by definition — that's its whole purpose —
# so unlike a plain docs repo, pushing it is never a default. Auto-pushing a
# stranger's personal notes to whatever remote happens to be configured is
# exactly the kind of surprise this plugin's non-negotiables rule out.
# Opt in explicitly with JARVIS_HUB_PUSH=1 once you've decided the hub's
# remote is somewhere you actually want this content to go.

branch="$(git -C "$hub" symbolic-ref --short -q HEAD 2>/dev/null)"
if [ -z "$branch" ]; then echo "nopush:hub detached HEAD"; exit 0; fi

remote="$(git -C "$hub" remote 2>/dev/null | head -1)"
if [ -z "$remote" ]; then echo "nopush:hub no remote"; exit 0; fi

upstream="$(git -C "$hub" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"
if [ -z "$upstream" ]; then echo "nopush:hub no upstream for $branch"; exit 0; fi

if [ "${JARVIS_HUB_PUSH:-0}" != "1" ]; then
  echo "nopush:hub personal memory repo — set JARVIS_HUB_PUSH=1 to push"; exit 0
fi

if git -C "$hub" push --quiet 2>/tmp/jarvis-done-push-err; then
  echo "pushed:hub $branch -> $remote"
else
  echo "error:hub push failed: $(head -1 /tmp/jarvis-done-push-err | cut -c1-120)"
fi

exit 0
