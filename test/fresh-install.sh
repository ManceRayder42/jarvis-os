#!/bin/bash
# Fresh-install walk, black box. A fake HOME, a copy of the plugin, the real `setup` command to
# create the hub, and every hook run exactly as plugin.json registers it (sh -c, CLAUDE_PLUGIN_ROOT
# set, realistic stdin). Order: no hub -> empty hub -> hub created by `setup` -> seeded hub.
#   bash test/fresh-install.sh [plugin-dir]
set -u
SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
T=$(cd "$(mktemp -d)" && pwd -P); mkdir -p "$T/home" "$T/bin"
rsync -a --exclude .git --exclude .claude "$SRC/" "$T/plugin/"
ln -s "$(command -v node)" "$T/bin/node"; ln -s "$(command -v git)" "$T/bin/git"
printf '#!/bin/sh\necho "2.1.325 (Claude Code)"\n' > "$T/bin/claude"; chmod +x "$T/bin/claude"
unset JARVIS_HUB JARVIS_MEMORY_CHECK JARVIS_CORRECTION_CAPTURE CLAUDE_CONFIG_DIR JARVIS_HOST
export HOME="$T/home" PATH="$T/bin:/usr/bin:/bin" CLAUDE_PLUGIN_ROOT="$T/plugin" JARVIS_STATE_DIR="$T/state"
fail=0
check() { if eval "$2"; then echo "  ok    $1"; else echo "  FAIL  $1"; fail=1; fi; }

# hook <event> <stdin-json> : run every command plugin.json registers for the event, print stdout.
hook() {
  node -e '
    const p = require(process.argv[1] + "/.claude-plugin/plugin.json");
    for (const g of (p.hooks[process.argv[2]] || [])) for (const h of g.hooks) console.log(h.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, process.argv[1]));
  ' "$T/plugin" "$1" | while IFS= read -r cmd; do printf '%s' "$2" | sh -c "$cmd"; echo "::rc=$?" >> "$T/rc.log"; done
}
START='{"hook_event_name":"SessionStart","session_id":"fi","cwd":"/tmp","source":"startup"}'
prompt() { node -e 'console.log(JSON.stringify({hook_event_name:"UserPromptSubmit",session_id:process.argv[2],cwd:"/tmp",prompt:process.argv[1]}))' "$1" "$2"; }
rc_ok() { ! grep -v '::rc=0' "$T/rc.log" >/dev/null 2>&1; }

echo "== 1. no hub configured"
: > "$T/rc.log"
before=$(find "$HOME" | sort | cksum)
out=$(hook SessionStart "$START"; hook UserPromptSubmit "$(prompt 'No, I said use tabs' s1)")
check "all registered hooks exit 0" "rc_ok"
check "only the existing setup nudge is printed" "[ \"\$(printf '%s' \"\$out\" | grep -c 'jarvis-os')\" = 1 ] && printf '%s' \"\$out\" | grep -q 'Not set up yet'"
check "HOME untouched" "[ \"\$(find \"$HOME\" | sort | cksum)\" = '$before' ]"

echo "== 2. empty hub folder"
mkdir "$T/empty"; echo "$T/empty" > "$HOME/.jarvis-hub-path"
: > "$T/rc.log"
out=$(hook SessionStart "$START"; hook UserPromptSubmit "$(prompt 'תפסיק לעשות את זה' s2)")
check "hooks exit 0" "rc_ok"
check "no checker line, no correction line" "! printf '%s' \"\$out\" | grep -q 'memory check\\|corrects you'"
check "empty hub stays empty" "[ -z \"\$(ls -A $T/empty)\" ]"

echo "== 3. hub created by the real setup command"
node "$T/plugin/setup/agent.mjs" setup --hub "$T/nest" >"$T/setup.log" 2>&1
check "setup ok, MEMORY.md seeded" "[ -f $T/nest/MEMORY.md ] && [ -f $T/nest/working-rules.md ]"
check "pointer file written" "[ \"\$(cat $HOME/.jarvis-hub-path)\" = '$T/nest' ]"
snap=$(cd "$T/nest" && find . -type f -not -name '.memory-check-stamp' -not -path './reports/*' | sort | xargs cat | cksum)
: > "$T/rc.log"
out=$(hook SessionStart "$START")
check "SessionStart hooks exit 0" "rc_ok"
check "memory loads" "printf '%s' \"\$out\" | grep -q 'Jarvis memory'"
check "checker is silent on a clean template hub" "! printf '%s' \"\$out\" | grep -q 'memory check'"
check "working rules carry the stale-fact lines" "printf '%s' \"\$out\" | grep -q 'Memory can be stale'"
: > "$T/rc.log"
en=$(hook UserPromptSubmit "$(prompt 'No, I said use tabs' s3)")
he=$(hook UserPromptSubmit "$(prompt 'לא, אמרתי שצריך טאבים' s4)")
no=$(hook UserPromptSubmit "$(prompt 'please add a README section' s5)")
check "correction hook exit 0" "rc_ok"
check "English correction -> one rule instruction" "[ \"\$(printf '%s\\n' \"\$en\" | grep -c '')\" = 1 ] && printf '%s' \"\$en\" | grep -q 'If this corrects you'"
check "Hebrew correction -> one rule instruction" "printf '%s' \"\$he\" | grep -q 'If this corrects you'"
check "ordinary prompt -> silence" "[ -z \"\$no\" ]"
check "memory files unchanged by every hook" "[ \"\$(cd $T/nest && find . -type f -not -name '.memory-check-stamp' -not -path './reports/*' | sort | xargs cat | cksum)\" = '$snap' ]"

echo "== 4. seeded hub: dead path, dangling index line, bad check: verb"
printf -- '---\nname: old\ndescription: d\ncheck: version node 99\n---\nDeploy: `/Users/nobody/deploy-gone.sh`\n' > "$T/nest/project_old.md"
sed -i.bak 's/## Reference/- [Gone](gone.md) - x\n\n## Reference/' "$T/nest/MEMORY.md" && rm "$T/nest/MEMORY.md.bak"
rm -f "$T/nest/.memory-check-stamp"
: > "$T/rc.log"
out=$(hook SessionStart "$START")
check "exit 0" "rc_ok"
line=$(printf '%s\n' "$out" | grep 'memory check')
check "one notice line with a report path" "[ \"\$(printf '%s\n' \"\$out\" | grep -c 'memory check')\" = 1 ] && printf '%s' \"\$line\" | grep -q 'reports/memory-check-'"
rep=$(ls "$T/nest"/reports/memory-check-*.md 2>/dev/null | head -1)
check "report lists the dead path" "grep -q 'deploy-gone.sh. does not exist' '$rep'"
check "report lists the dangling index line" "grep -q 'gone.md. does not exist' '$rep'"
check "report lists the unindexed file" "grep -q 'project_old.md. has no line' '$rep'"
check "report lists the unknown verb (not run)" "grep -q 'unknown verb \"version\"' '$rep'"
check "second session inside 24h is silent" "! hook SessionStart '$START' | grep -q 'memory check'"

echo "tmp: $T"; [ $fail -eq 0 ] && echo ALL OK || echo SOME FAILED; exit $fail
