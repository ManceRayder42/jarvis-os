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

Project mode (Active Projects stays an index, history lives elsewhere):
    python3 update-context.py --project "Name" --status "one-line current state" \
        [--history "dated detail"]        # or --history - to read it from stdin

    * REPLACES the project's single status line under "## Active Projects"
      (inserts it if the project is new). Never adds a second line.
    * ADDS the detail, newest first, to <hub>/projects/<slug>.md (created with
      small frontmatter if absent). Re-sending an identical entry is a no-op.
    * Any stray extra lines for the same project (legacy hubs) are moved
      verbatim into that history file, not dropped.
    * Status is capped at 360 chars (truncated with an ellipsis, never rejected).
    * History is written before CONTEXT.md, so a failure leaves CONTEXT.md as-is.

Exit 0 on success (prints a one-line summary). Exit 2 on empty/invalid input.
Exit 1 only on a genuine write failure (caller should surface that, not retry
blindly).
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

PROJECTS_DIR = HUB / "projects"
PLACEHOLDER = "(nothing tracked yet)"
MAX_STATUS = 360


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def project_key(line):
    """Project name a top-level Active Projects bullet belongs to, or None."""
    m = re.match(r"^- (?:\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\*\*(.+?)\*\*)", line)
    if not m:
        return None
    return (m.group(1) or m.group(2)).strip().lower()


def append_history(slug, name, entry_line):
    """Add entry_line (newest first) to <hub>/projects/<slug>.md. Returns True if added."""
    f = PROJECTS_DIR / f"{slug}.md"
    if f.exists():
        lines = f.read_text(encoding="utf-8").splitlines()
    else:
        lines = ["---", f"name: {slug}",
                 f"description: Dated history for the {name} project. CONTEXT.md keeps only a one-line status.",
                 "---", "", f"# {name} - project history", "",
                 "Newest first. CONTEXT.md holds the one-line status; add dated entries here.", ""]
    if entry_line in lines:
        return False
    at = next((i for i, l in enumerate(lines) if l.startswith(("- ", "## "))), None)
    if at is None:
        while lines and not lines[-1].strip():
            lines.pop()
        lines += ["", entry_line]
    else:
        lines[at:at] = [entry_line, ""]
    _write_atomic(f, "\n".join(lines).rstrip() + "\n")
    return True


def update_project(args):
    name = " ".join(args.project.split())
    status = " ".join(args.status.split())
    if not name or not status or not slugify(name):
        print("update-context: --project and --status must be non-empty", file=sys.stderr)
        return 2
    if len(status) > MAX_STATUS:
        status = status[:MAX_STATUS - 1].rstrip() + "\u2026"
    today = args.date or datetime.date.today().isoformat()
    slug = slugify(name)

    hist = args.history
    if hist == "-":
        hist = sys.stdin.read()
    hist = " ".join((hist or "").split())

    new_line = f"- **{name}** ({today}): {status} History: `projects/{slug}.md`"

    if not CTX.exists():
        CTX.parent.mkdir(parents=True, exist_ok=True)
        CTX.write_text(SCAFFOLD, encoding="utf-8")
    lines = CTX.read_text(encoding="utf-8").splitlines()

    h = next((i for i, l in enumerate(lines) if l.strip() == "## Active Projects"), None)
    if h is None:
        at = next((i for i, l in enumerate(lines) if l.strip() == "## Recent Sessions"), len(lines))
        lines[at:at] = ["## Active Projects", ""]
        h = at
    end = next((i for i in range(h + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    section = lines[h + 1:end]

    # Split the section into entry blocks: a top-level bullet plus its indented continuation lines.
    out, extras, key, placed, i = [], [], name.lower(), False, 0
    while i < len(section):
        l = section[i]
        if l.strip() == PLACEHOLDER:
            i += 1
            continue
        if l.startswith("- ") and project_key(l) == key:
            block = [l]
            i += 1
            while i < len(section) and section[i].strip() and not section[i].startswith("- ") \
                    and section[i][:1] in (" ", "\t"):
                block.append(section[i])
                i += 1
            if not placed:
                out.append(new_line)
                placed = True
            else:
                extras.append(" ".join(b.strip() for b in block))
            continue
        out.append(l)
        i += 1
    if not placed:
        while out and not out[-1].strip():
            out.pop()
        out.append(new_line)
    while out and not out[0].strip():
        out.pop(0)
    while out and not out[-1].strip():
        out.pop()
    new_section = [""] + out + [""]
    new_lines = lines[:h + 1] + new_section + lines[end:]

    added = 0
    try:
        entries = []
        if hist:
            entries.append(f"- **{today}:** {hist}")
        entries += [f"- (moved from CONTEXT.md) {x[2:] if x.startswith('- ') else x}" for x in extras]
        for e in reversed(entries):
            added += 1 if append_history(slug, name, e) else 0
        _write_atomic(CTX, "\n".join(new_lines).rstrip() + "\n")
    except OSError as exc:
        print(f"update-context: write failed: {exc}", file=sys.stderr)
        return 1
    print(f"update-context: project={slug} status_line=1 history_added={added} "
          f"extra_lines_moved={len(extras)} size={CTX.stat().st_size}B")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", type=int, default=12)
    ap.add_argument("--project", help="project mode: project name (replaces its single status line)")
    ap.add_argument("--status", help="project mode: one-line current state (max 360 chars)")
    ap.add_argument("--history", help="project mode: dated detail for projects/<slug>.md ('-' = read stdin)")
    ap.add_argument("--date", help="project mode: override today's date (YYYY-MM-DD)")
    args = ap.parse_args()

    if args.project is not None or args.status is not None:
        if not args.project or not args.status:
            print("update-context: --project and --status go together", file=sys.stderr)
            return 2
        return update_project(args)

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
