# Wall protocol — a blocker is a claim that needs evidence

**Problem.** An agent hits a wall ("this session has no browser tool") and reports it as
final. The way around it is often one command away: a fresh `claude -p` process with the
missing flag or MCP loads tools the current session missed at startup. Nobody thinks of it
unless the rule says to.

## 1. Paste into CLAUDE.md

```markdown
## Wall protocol
"I can't / no tool / blocked / not available" is the start of a search, not a report.
Before reporting anything as blocked:
1. Read `~/.claude/knowledge/workaround-map.md` — known walls and escapes.
2. List at least 2 workarounds and try the cheapest. Default first move: a fresh
   `claude -p` process with the missing flag/MCP/model (e.g. `--chrome`) — the current
   session's tool list is not the machine's limit.
3. Report a blocker only after the workarounds failed, naming each one tried and why.
   Then give the single action that unblocks it.
4. When a new escape works, append it to the map.
```

## 2. Start a workaround map

Create `~/.claude/knowledge/workaround-map.md`:

```markdown
# Workaround Map
## Standard moves (cheapest first)
1. Fresh process: `claude -p --model sonnet [--chrome] [--mcp-config f] "<task>"`
2. Another path: CLI/API instead of UI, script instead of tool, other account
3. Delegate: subagent, cloud routine
4. Reorder: do the unblocked parts now, queue the blocked step
5. Only then ask the human — with what was tried

## Known walls
| Wall | Escape | Verified |
|---|---|---|
| Session has no Claude in Chrome tools | `claude -p --chrome "<task>"` | |
```

## 3. Optional: enforce it with a Stop hook

`wall-check.py` (this folder) rejects a final reply that claims a blocker (English or
Hebrew) without naming a workaround, and sends the agent back once. It fails open on any
error and never loops (`stop_hook_active`).

```bash
cp wall-check.py ~/.claude/hooks/ && chmod +x ~/.claude/hooks/wall-check.py
```

Add to `~/.claude/settings.json`:

```json
"hooks": { "Stop": [ { "hooks": [ { "type": "command",
  "command": "python3 -I ~/.claude/hooks/wall-check.py", "timeout": 5 } ] } ] }
```

**Verify:** end a turn with "I can't do that, no tool." The hook should send you back.
Trade-off: an occasional false positive costs one extra turn.
