#!/bin/bash
# Sandboxed CLI run: fake HOME, copy of the plugin tree, a stub `claude` that only logs.
set -u
SRC="$1"; T=$(cd "$(mktemp -d)" && pwd -P); mkdir -p "$T/home" "$T/bin" "$T/vault"
rsync -a --exclude .git --exclude .claude "$SRC/" "$T/plugin/"
(cd "$T/plugin" && git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm base)
ln -s "$(command -v node)" "$T/bin/node"; ln -s "$(command -v git)" "$T/bin/git"
# Stub claude: records every call, changes nothing on the real machine.
printf '#!/bin/sh\necho "$*" >> "%s/claude-calls.log"\necho "2.1.325 (Claude Code)"\n' "$T" > "$T/bin/claude"; chmod +x "$T/bin/claude"
unset JARVIS_HUB CLAUDE_CONFIG_DIR JARVIS_HOST
export HOME="$T/home" PATH="$T/bin:/usr/bin:/bin"
A="$T/plugin/setup/agent.mjs"; fail=0
run() { echo "\$ agent.mjs $*"; node "$A" "$@"; c=$?; echo "  -> exit $c"; [ $c -eq 0 ] || fail=1; }
check() { if eval "$2"; then echo "  CHECK ok: $1"; else echo "  CHECK FAIL: $1"; fail=1; fi; }
cd "$T"
run setup --hub nest
check "pointer = $T/nest" "[ \"\$(cat $T/home/.jarvis-hub-path)\" = '$T/nest' ]"
run status
check "status shows nest" "node '$A' status | grep -q 'Memory  — $T/nest'"
run disable grill-me
check "grill-me parked" "[ ! -e $T/plugin/skills/grill-me ] && [ -f $T/plugin/optional-skills/grill-me/SKILL.md ]"
run skills >/dev/null
check "skills lists grill-me off" "node '$A' skills | grep -q '^✗ grill-me'"
run enable grill-me
check "grill-me back as real dir" "[ -d $T/plugin/skills/grill-me ] && [ ! -L $T/plugin/skills/grill-me ]"
check "plugin tree tracked files unchanged" "[ -z \"\$(cd $T/plugin && git status --porcelain | grep -v '^??')\" ]"
run obsidian vault
check "vault/Jarvis -> nest" "[ \"\$(readlink $T/vault/Jarvis)\" = '$T/nest' ]"
check "no default hub created" "[ ! -e $T/home/jarvis-hub ]"
check "nest seeded" "[ -f $T/nest/MEMORY.md ]"
echo "stub claude calls:"; cat "$T/claude-calls.log" 2>/dev/null | sed "s/^/  /"; echo "sandbox: $T"; [ $fail -eq 0 ] && echo ALL OK || echo SOME FAILED; exit $fail
