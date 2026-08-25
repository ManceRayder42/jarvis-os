#!/usr/bin/env python3
"""update-context.py — prepend one session entry to <hub>/CONTEXT.md; keep newest N; archive overflow.

Why this exists: the naive way to do step 4 of /done is to edit CONTEXT.md in
place, which forces the model to Read the whole file every run — on a file
that grows for months, that gets expensive fast. This script does the update
without the model ever reading the file — it just pipes in the new entry text.

Usage:
    python3 update-context.py [--keep N] <<'ENTRY'
    - Date: 2026-07-01 (topic) — one-line summary ... Note: `sessions/2026-07-01-slug.md`
    ENTRY

The new entry goes at the top of the marker-bounded region:
    <!-- SESSIONS:START -->  ... newest first ...  <!-- SESSIONS:END -->
Overflow past N is appended verbatim to archive/CONTEXT-sessions-pre-YYYY-MM.md.

Unlike a hand-curated file such as MEMORY.md, CONTEXT.md is *owned* by this
skill — nothing else is expected to hand-edit it — so if it doesn't exist yet
(fresh hub, first-ever /done run) or the markers are missing, this script
creates/repairs the scaffold itself instead of asking the caller to fall back
to a manual Edit.

Exit 0 on success (prints a one-line summary). Exit non-zero only on a genuine
write failure (caller should surface that, not retry blindly).
"""
import sys, os, re, datetime, pathlib, argparse

def resolve_hub():
    env = os.environ.get("JARVIS_HUB", "").strip()
    if env:
        return pathlib.Path(env).expanduser()
    pointer = pathlib.Path.home() / ".jarvis-hub-path"
    if pointer.is_file():
        raw = pointer.read_text(encoding="utf-8").strip()
        if raw:
            return pathlib.Path(raw).expanduser()
    return pathlib.Path.home() / "jarvis-hub"

HUB = resolve_hub()
CTX = HUB / "CONTEXT.md"
ARCHIVE_DIR = HUB / "archive"
START = "<!-- SESSIONS:START -->"
END = "<!-- SESSIONS:END -->"

SCAFFOLD = """---
name: context
description: Cross-session state for this hub — last session, active projects, open threads, recent decisions. Owned by the done skill; don't hand-edit the Recent Sessions region.
metadata:
  type: reference
---

# Context

## Active Projects
(nothing tracked yet)

## Open Threads
(nothing tracked yet)

## Recent Decisions
(nothing tracked yet)

## Recent Sessions
<!-- SESSIONS:START -->
<!-- SESSIONS:END -->
"""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", type=int, default=12)
    args = ap.parse_args()

    entry = sys.stdin.read().strip()
    if not entry:
        print("update-context: empty entry on stdin, nothing to do", file=sys.stderr)
        return 2
    entry_line = " ".join(l.strip() for l in entry.splitlines() if l.strip())
    if not entry_line.startswith("- "):
        entry_line = "- " + entry_line

    if not CTX.exists():
        CTX.parent.mkdir(parents=True, exist_ok=True)
        CTX.write_text(SCAFFOLD, encoding="utf-8")

    text = CTX.read_text(encoding="utf-8")
    lines = text.splitlines()
    try:
        s = next(i for i, l in enumerate(lines) if l.strip() == START)
        e = next(i for i, l in enumerate(lines) if l.strip() == END)
    except StopIteration:
        # Markers missing from an existing (probably hand-started) CONTEXT.md
        # — append a fresh Recent Sessions region rather than erroring, since
        # nothing else in this file format is guaranteed present on a
        # stranger's machine the way it would be on a curated personal vault.
        lines += ["", "## Recent Sessions", START, END]
        s = len(lines) - 2
        e = len(lines) - 1

    region = [l for l in lines[s + 1:e] if l.strip()]  # existing entries, newest first

    # Idempotency: /done can run twice in a day (the session note gets a "Part 2"
    # section rather than a second file). If this entry points at a session note
    # already listed, replace that line instead of stacking a near-duplicate.
    replaced = 0
    note_ref = re.search(r"sessions/[\w.\-/]+\.md", entry_line)
    if note_ref:
        ref = note_ref.group(0)
        pruned = [l for l in region if ref not in l]
        replaced = len(region) - len(pruned)
        region = pruned

    combined = [entry_line] + region
    keep, overflow = combined[:args.keep], combined[args.keep:]

    if overflow:
        ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.date.today().isoformat()
        month = datetime.date.today().strftime("%Y-%m")
        archive_file = ARCHIVE_DIR / f"CONTEXT-sessions-pre-{month}.md"
        head = ("---\ntype: reference\ndescription: Archived CONTEXT.md session history "
                "(overflow past the newest live entries).\n---\n\n# CONTEXT — Archived Sessions\n")
        prior = archive_file.read_text(encoding="utf-8") if archive_file.exists() else head
        banner = f"\n\n<!-- archived {stamp} by /done update-context (overflow past newest {args.keep}) -->\n"
        archive_file.write_text(prior + banner + "\n".join(overflow).rstrip() + "\n", encoding="utf-8")

    out = lines[:s + 1] + keep + lines[e:]
    tmp = CTX.with_suffix(CTX.suffix + ".tmp")
    tmp.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
    os.replace(tmp, CTX)
    print(f"update-context: prepended 1, replaced={replaced}, live={len(keep)}, "
          f"archived={len(overflow)}, size={CTX.stat().st_size}B")
    return 0

if __name__ == "__main__":
    sys.exit(main())
