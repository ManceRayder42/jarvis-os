#!/usr/bin/env python3
"""Stop hook: reject a final reply that claims a blocker without listing workarounds.

Wall protocol (~/.claude/CLAUDE.md). Fails open: any error -> exit 0.
Checks the last assistant turn's text AND any Telegram reply text it sent.
"""
import json
import re
import sys

BLOCKER = re.compile(
    r"\b(can'?t|cannot|unable to|not available|no access|blocked|don'?t have (the )?(tool|access))\b"
    r"|אין לי|לא יכול|לא אפשרי|חסום|תקוע|אי אפשר",
    re.I,
)
WORKAROUND = re.compile(
    r"workaround|tried|ניסיתי|עקיפ|claude -p|alternative|instead|במקום|escape|fallback",
    re.I,
)


def last_assistant_text(path):
    texts = []
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    for line in reversed(lines):
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type")
        if t == "user":
            msg = e.get("message", {})
            content = msg.get("content")
            # a real user prompt (not a tool_result) ends the assistant turn
            if isinstance(content, str) or (
                isinstance(content, list)
                and any(c.get("type") == "text" for c in content if isinstance(c, dict))
            ):
                break
            continue
        if t != "assistant":
            continue
        for c in e.get("message", {}).get("content", []) or []:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "text":
                texts.append(c.get("text", ""))
            elif c.get("type") == "tool_use" and "reply" in c.get("name", ""):
                texts.append(str(c.get("input", {}).get("text", "")))
    return "\n".join(texts)


def main():
    try:
        data = json.load(sys.stdin)
        if data.get("stop_hook_active"):
            return 0
        text = last_assistant_text(data["transcript_path"])
        if BLOCKER.search(text) and not WORKAROUND.search(text):
            print(json.dumps({
                "decision": "block",
                "reason": (
                    "Wall protocol: your reply claims a blocker but lists no workaround. "
                    "Read ~/.claude/knowledge/workaround-map.md, try at least 2 workarounds "
                    "(first: a fresh `claude -p` with the missing flag/MCP/model), then reply "
                    "with what you tried. If it is not a blocker claim, say so in one line."
                ),
            }))
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
