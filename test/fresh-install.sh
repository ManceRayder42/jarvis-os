#!/bin/bash
# Fresh-install walk, black box. A fake HOME, a copy of the plugin, the real `setup` command to
# create the hub, and every hook run exactly as plugin.json registers it (sh -c, CLAUDE_PLUGIN_ROOT
# set, realistic stdin). Order: no hub -> empty hub -> hub created by `setup` -> seeded hub ->
# the memory-setup skill on a second, brand-new HOME.
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
check "only the existing setup nudge is printed" "[ \"\$(printf '%s' \"\$out\" | grep -c 'shufi')\" = 1 ] && printf '%s' \"\$out\" | grep -q 'Not set up yet'"
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

echo "== 5. memory-setup skill: brand-new HOME, no env, no hub"
H2="$T/home2"; mkdir -p "$H2"
MS="$T/plugin/skills/memory-setup/scripts/memory-setup.mjs"
tree_hash() { (cd "$1" && find . | sort | while IFS= read -r f; do if [ -f "$f" ]; then printf '%s ' "$f"; cat "$f"; else printf '%s\n' "$f"; fi; done) | cksum; }
h0=$(tree_hash "$H2")
dry=$(HOME="$H2" node "$MS" --dry-run --lang en); rc_dry=$?
check "--dry-run exits 0 and writes nothing" "[ $rc_dry = 0 ] && [ \"\$(tree_hash $H2)\" = '$h0' ] && printf '%s' \"\$dry\" | grep -q 'would create'"
out=$(HOME="$H2" node "$MS" --lang en); rc=$?
check "setup exits 0 and reports created" "[ $rc = 0 ] && printf '%s' \"\$out\" | grep -q 'created'"
check "hub, knowledge pack, wiki, raw all created" "[ -f $H2/jarvis-hub/MEMORY.md ] && [ -f $H2/jarvis-hub/knowledge/index.md ] && [ -f $H2/jarvis-hub/knowledge/README.md ] && [ -f $H2/jarvis-hub/wiki/index.md ] && [ -f $H2/jarvis-hub/raw/README.md ]"
# the block carries the hub path 3 times; a temp path is far longer than a real one, so test the rest
check "user-level CLAUDE.md has the marked block; without the 3 hub paths it is under 450 bytes" "grep -q 'shufi-memory:begin v1' $H2/.claude/CLAUDE.md && [ \$(( \$(wc -c < $H2/.claude/CLAUDE.md) - 3 * \${#H2} - 3 * 11 )) -le 450 ]"
check "setup verified both hooks and ran the checker" "printf '%s' \"\$out\" | grep -q 'memory-check .*clean' && printf '%s' \"\$out\" | grep -q 'correction-capture .*undo'"
h1=$(tree_hash "$H2")
out2=$(HOME="$H2" node "$MS" --lang en)
check "second run: tree hash identical and 'Nothing to do'" "[ \"\$(tree_hash $H2)\" = '$h1' ] && printf '%s' \"\$out2\" | grep -q 'Nothing to do'"
he=$(HOME="$H2" node "$MS" --lang he)
check "--lang he prints Hebrew" "printf '%s' \"\$he\" | grep -q 'אין מה לעשות'"
check "--lang he second run still changes nothing" "[ \"\$(tree_hash $H2)\" = '$h1' ]"
# the hooks work on the hub the skill built
: > "$T/rc.log"
out=$(HOME="$H2" hook SessionStart "$START"; HOME="$H2" hook UserPromptSubmit "$(prompt 'No, I said use tabs' s6)")
check "hooks exit 0 on the new hub" "rc_ok"
check "memory loads from the new hub, checker silent" "printf '%s' \"\$out\" | grep -q 'Jarvis memory' && ! printf '%s' \"\$out\" | grep -q 'memory check'"
check "correction hook fires on the new hub" "printf '%s' \"\$out\" | grep -q 'If this corrects you'"
# an existing user CLAUDE.md keeps its text
H3="$T/home3"; mkdir -p "$H3/.claude"; printf '# mine\nline two (עברית)\nno trailing newline' > "$H3/.claude/CLAUDE.md"; cp "$H3/.claude/CLAUDE.md" "$T/claude.orig"
HOME="$H3" node "$MS" --lang en >/dev/null
check "existing CLAUDE.md: original text kept byte for byte before the block" "head -c \$(wc -c < $T/claude.orig) $H3/.claude/CLAUDE.md | cmp -s - $T/claude.orig && grep -q 'shufi-memory:end' $H3/.claude/CLAUDE.md"
mkdir -p "$T/home4/jarvis-hub/knowledge"; printf 'MY INDEX\n' > "$T/home4/jarvis-hub/knowledge/index.md"
HOME="$T/home4" node "$MS" --lang en >/dev/null
check "existing knowledge/index.md untouched" "[ \"\$(cat $T/home4/jarvis-hub/knowledge/index.md)\" = 'MY INDEX' ]"

echo "tmp: $T"; [ $fail -eq 0 ] && echo ALL OK || echo SOME FAILED; exit $fail
