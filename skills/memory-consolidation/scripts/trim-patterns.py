#!/usr/bin/env python3
"""trim-patterns.py — rotate <hub>/patterns.md: keep frontmatter + curated
sections + dated '## YYYY-MM-DD' sections from the last N days; move older
dated sections into <hub>/archive/patterns-YYYY-MM.md (grouped by month).

Why this exists: patterns.md grows by nightly append (memory-consolidation)
and has no rotation of its own, unlike CONTEXT.md (see ../../done/scripts/
update-context.py, which this script mirrors: hub-resolved paths, stdlib
only, exit-code contract, one-line summary print).

Duplicate headers: organic nightly appends can produce multiple
'## YYYY-MM-DD' sections for the same date (and, rarely, more than one of the
same curated header). This script merges each group under a single header:
the first occurrence's header line is kept verbatim; a later BARE duplicate
header line is deleted (content-free, so removing it loses nothing); a later
header that carries a descriptive suffix (e.g. "## 2026-05-31 (Part 2 —
...)") is demoted in place to a "**(Part 2 — ...)**" marker line — a 1-for-1
line replacement, not a deletion, so the suffix text survives. Body lines are
never trimmed or reformatted — they're concatenated verbatim in original
order, so no line is ever silently created or destroyed outside of the
tracked duplicate-header deletions.

Accounting invariant (printed every run): old_total - dup_headers_removed ==
new_total + archived_content_lines. Content-preserving: every input line
either stays in patterns.md, lands in an archive file, or was a tracked
duplicate header deletion counted in the delta.

Usage:
    python3 trim-patterns.py [--keep-days 14] [--as-of YYYY-MM-DD] [--dry-run]

Exit 0 on success. Exit non-zero if frontmatter/sections aren't found in the
expected shape (caller should fall back to a manual Edit) or if the
accounting invariant fails to reconcile (patterns.md is NOT written in that
case).
"""
import sys
import re
import datetime
import pathlib
import argparse
import collections
import os


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
PATTERNS = HUB / "patterns.md"
ARCHIVE_DIR = HUB / "archive"

DATE_RE = re.compile(r"^## (\d{4}-\d{2}-\d{2})\s*(.*)$")
CURATED_ORDER = ["Observed Patterns", "Applied Suggestions", "Tracking", "Dismissed"]


def curated_key(header_text_after_hashes):
    for name in CURATED_ORDER:
        if header_text_after_hashes.startswith(name):
            return name
    return None


def parse_sections(lines, start_idx):
    """Split lines[start_idx:] into (header_line, body_lines) per top-level '## ' section."""
    sections = []
    i, n = start_idx, len(lines)
    while i < n:
        if lines[i].startswith("## "):
            header = lines[i]
            j = i + 1
            body = []
            while j < n and not lines[j].startswith("## "):
                body.append(lines[j])
                j += 1
            sections.append((header, body))
            i = j
        else:
            i += 1
    return sections


def date_suffix_of(header_line):
    m = DATE_RE.match(header_line)
    return m.group(2).strip() if m and m.group(2).strip() else ""


def merge_group(headers_and_bodies, suffix_of=None):
    """First occurrence's header kept verbatim. Later bare-duplicate headers are
    deleted (dup_removed += 1 each). Later suffixed headers are demoted to a
    bold marker line (no line-count change). Bodies are concatenated verbatim."""
    dup_removed = 0
    out = []
    for k, (header, body) in enumerate(headers_and_bodies):
        if k == 0:
            out.append(header)
        else:
            suffix = suffix_of(header) if suffix_of else ""
            if suffix:
                out.append(f"**{suffix}**")
            else:
                dup_removed += 1
        out.extend(body)
    return out, dup_removed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-days", type=int, default=14)
    ap.add_argument("--as-of", type=str, default=None, help="override 'today' as YYYY-MM-DD, for testing")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    today = datetime.date.fromisoformat(args.as_of) if args.as_of else datetime.date.today()
    cutoff = today - datetime.timedelta(days=args.keep_days)

    if not PATTERNS.exists():
        print(f"trim-patterns: {PATTERNS} not found", file=sys.stderr)
        return 3

    text = PATTERNS.read_text(encoding="utf-8")
    lines = text.splitlines()
    old_total = len(lines)

    if not lines or lines[0].strip() != "---":
        print("trim-patterns: no frontmatter found — fall back to manual Edit", file=sys.stderr)
        return 3
    try:
        close_idx = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        print("trim-patterns: frontmatter not closed — fall back to manual Edit", file=sys.stderr)
        return 3
    frontmatter = lines[:close_idx + 1]

    i = close_idx + 1
    while i < len(lines) and not lines[i].startswith("## "):
        i += 1
    preamble = lines[close_idx + 1:i]

    sections = parse_sections(lines, i)
    if not sections:
        print("trim-patterns: no '## ' sections found — fall back to manual Edit", file=sys.stderr)
        return 3

    curated_groups = {name: [] for name in CURATED_ORDER}
    curated_other = []
    dated_groups = collections.OrderedDict()

    for header, body in sections:
        after = header[3:]
        m = DATE_RE.match(header)
        if m:
            dated_groups.setdefault(m.group(1), []).append((header, body))
        else:
            key = curated_key(after)
            if key:
                curated_groups[key].append((header, body))
            else:
                curated_other.append((header, body))

    total_dup_removed = 0

    curated_out = []
    for name in CURATED_ORDER:
        group = curated_groups[name]
        if not group:
            continue
        merged, dup = merge_group(group)
        total_dup_removed += dup
        curated_out.append(merged)
    for header, body in curated_other:
        curated_out.append([header] + body)

    kept_out = []
    archived_by_month = collections.OrderedDict()
    archived_content_lines = 0

    for date_str in sorted(dated_groups.keys()):
        group = dated_groups[date_str]
        merged, dup = merge_group(group, suffix_of=date_suffix_of)
        total_dup_removed += dup
        date_obj = datetime.date.fromisoformat(date_str)
        if date_obj >= cutoff:
            kept_out.append(merged)
        else:
            month = date_str[:7]
            archived_by_month.setdefault(month, []).append(merged)
            archived_content_lines += len(merged)

    new_lines = list(frontmatter) + list(preamble)
    for block in curated_out:
        new_lines.extend(block)
    for block in kept_out:
        new_lines.extend(block)
    new_total = len(new_lines)
    new_text = "\n".join(new_lines).rstrip("\n") + "\n"

    archive_writes = []
    for month in sorted(archived_by_month.keys()):
        blocks = archived_by_month[month]
        archive_path = ARCHIVE_DIR / f"patterns-{month}.md"
        prior = archive_path.read_text(encoding="utf-8") if archive_path.exists() else (
            f"# Patterns Archive — {month}\n\n"
            f"Entries rotated out of patterns.md ({args.keep_days}-day rolling) by trim-patterns.py.\n"
        )
        banner = f"\n<!-- archived {today.isoformat()} by trim-patterns.py (cutoff {cutoff.isoformat()}) -->\n"
        body_text = "\n\n".join("\n".join(b) for b in blocks)
        new_archive_text = prior.rstrip("\n") + "\n" + banner + "\n" + body_text.rstrip("\n") + "\n"
        archive_writes.append((archive_path, new_archive_text))

    reconciled = new_total + archived_content_lines
    ok = (old_total - total_dup_removed) == reconciled

    if args.dry_run:
        print(f"[dry-run] old_total={old_total} dup_headers_removed={total_dup_removed} "
              f"new_total={new_total} archived_content_lines={archived_content_lines} "
              f"check: {old_total}-{total_dup_removed} == {new_total}+{archived_content_lines} -> "
              f"{'OK' if ok else 'MISMATCH'}")
        for path, content in archive_writes:
            print(f"[dry-run] would write {path} ({len(content.splitlines())} lines)")
        return 0 if ok else 1

    if not ok:
        print(f"trim-patterns: accounting MISMATCH (old_total={old_total} dup_headers_removed={total_dup_removed} "
              f"new_total={new_total} archived_content_lines={archived_content_lines}) — refusing to write", file=sys.stderr)
        return 4

    PATTERNS.write_text(new_text, encoding="utf-8")
    for path, content in archive_writes:
        path.parent.mkdir(exist_ok=True)
        path.write_text(content, encoding="utf-8")

    print(f"trim-patterns: old_total={old_total} dup_headers_removed={total_dup_removed} "
          f"new_total={new_total} archived_content_lines={archived_content_lines} reconciled=OK "
          f"size={PATTERNS.stat().st_size}B archived_files={[str(p) for p, _ in archive_writes]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
