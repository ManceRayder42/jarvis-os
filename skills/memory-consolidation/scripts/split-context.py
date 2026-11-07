#!/usr/bin/env python3
"""split-context.py - one-time migration: turn a long "## Active Projects" section
in <hub>/CONTEXT.md into one status line per project, moving the history out.

Why: CONTEXT.md is read at the start of every session. A hub that has logged one
dated line per update for months ends up with an Active Projects section that
dwarfs everything else. This keeps CONTEXT.md an index and moves the rest to
<hub>/projects/<slug>.md, verbatim and lossless.

Usage:
    python3 split-context.py            # dry run: prints the plan, writes nothing
    python3 split-context.py --apply    # backup, then migrate

What --apply does, in order:
  1. Copies CONTEXT.md to <hub>/archive/CONTEXT-YYYY-MM-DD-pre-split.md
     (never overwrites; adds -2, -3 ... if the name is taken).
  2. Appends every original entry of each project, verbatim, to
     <hub>/projects/<slug>.md under a "Moved from CONTEXT.md" heading.
  3. Replaces the project's entries in CONTEXT.md with ONE status line: the
     entry carrying the latest YYYY-MM-DD date (else the first), cut to 360 chars.
Nothing else in CONTEXT.md is touched. Only projects with more than one entry, or
an entry longer than 480 chars, are migrated, so a second run finds nothing to
do and changes nothing. If anything fails before step 3 completes, CONTEXT.md is
left as it was.

Hub resolution matches the rest of the plugin: JARVIS_HUB, then ~/.jarvis-hub-path,
then ~/jarvis-hub.
"""
import argparse, datetime, os, pathlib, re, shutil, sys

MAX_STATUS = 360


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


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def entry_key(line):
    m = re.match(r"^- (?:\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\*\*(.+?)\*\*)", line)
    return (m.group(1) or m.group(2)).strip() if m else None


def write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def parse_section(section):
    """Return (items, order). items: ('raw', line) or ('entry', name, [lines])."""
    items, i = [], 0
    while i < len(section):
        l = section[i]
        name = entry_key(l) if l.startswith("- ") else None
        if name is None:
            items.append(("raw", l))
            i += 1
            continue
        block = [l]
        i += 1
        while i < len(section) and section[i].strip() and not section[i].startswith("- ") \
                and section[i][:1] in (" ", "\t"):
            block.append(section[i])
            i += 1
        items.append(("entry", name, block))
    return items


def pick_latest(blocks):
    def newest(b):
        dates = re.findall(r"\d{4}-\d{2}-\d{2}", " ".join(b))
        return max(dates) if dates else ""
    best = max(range(len(blocks)), key=lambda k: (newest(blocks[k]), -k))
    return blocks[best]


def split_status(block):
    """(date, text) of an entry with its name prefix and History pointer removed."""
    text = " ".join(x.strip() for x in block)
    text = re.sub(r"^- (?:\[\[[^\]]+\]\]|\*\*.+?\*\*)\s*", "", text)
    text = re.sub(r"\s*History:\s*`?projects/[^\s`]+`?.*$", "", text)
    m = re.match(r"^\*\*(\d{4}-\d{2}-\d{2}):?\*\*:?\s*(.*)$", text) or re.match(r"^\((\d{4}-\d{2}-\d{2})\):?\s*(.*)$", text)
    date = ""
    if m:
        date, text = m.group(1), m.group(2)
    return date, " ".join(text.split())


def status_line(name, slug, block):
    date, text = split_status(block)
    if len(text) > MAX_STATUS:
        text = text[:MAX_STATUS - 1].rstrip() + "…"
    stamp = f" ({date})" if date else ""
    return f"- **{name}**{stamp}: {text} History: `projects/{slug}.md`"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--date", help="override today's date (YYYY-MM-DD)")
    args = ap.parse_args()

    hub = resolve_hub()
    ctx = hub / "CONTEXT.md"
    if not ctx.is_file():
        print(f"split-context: {ctx} not found, nothing to do")
        return 0
    today = args.date or datetime.date.today().isoformat()
    lines = ctx.read_text(encoding="utf-8").splitlines()

    h = next((i for i, l in enumerate(lines) if l.strip() == "## Active Projects"), None)
    if h is None:
        print("split-context: no '## Active Projects' section, nothing to do")
        return 0
    end = next((i for i in range(h + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    items = parse_section(lines[h + 1:end])

    groups = {}
    for it in items:
        if it[0] == "entry":
            groups.setdefault(it[1].lower(), (it[1], []))[1].append(it[2])

    todo = {k: v for k, v in groups.items()
            if len(v[1]) > 1 or any(len(split_status(b)[1]) > MAX_STATUS for b in v[1])}
    if not todo:
        print("split-context: already one short line per project, nothing to do")
        return 0

    for k, (name, blocks) in todo.items():
        chars = sum(len(" ".join(b)) for b in blocks)
        print(f"  {name}: {len(blocks)} entr{'y' if len(blocks) == 1 else 'ies'}, {chars} chars -> projects/{slugify(name)}.md")
    if not args.apply:
        print("split-context: dry run, nothing written. Re-run with --apply.")
        return 0

    try:
        backup = hub / "archive" / f"CONTEXT-{today}-pre-split.md"
        n = 2
        while backup.exists():
            backup = hub / "archive" / f"CONTEXT-{today}-pre-split-{n}.md"
            n += 1
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ctx, backup)

        new_section, done = [], set()
        for it in items:
            if it[0] == "raw":
                new_section.append(it[1])
                continue
            k = it[1].lower()
            if k not in todo:
                new_section.extend(it[2])
                continue
            if k in done:
                continue
            done.add(k)
            name, blocks = todo[k]
            new_section.append(status_line(name, slugify(name), pick_latest(blocks)))

        # History first: if a project file fails to write, CONTEXT.md is still untouched.
        for k, (name, blocks) in todo.items():
            slug = slugify(name)
            f = hub / "projects" / f"{slug}.md"
            if f.exists():
                body = f.read_text(encoding="utf-8").rstrip() + "\n"
            else:
                body = (f"---\nname: {slug}\ndescription: Dated history for the {name} project. "
                        f"CONTEXT.md keeps only a one-line status.\n---\n\n# {name} - project history\n")
            body += f"\n## Moved from CONTEXT.md on {today}\n\nOriginal entries, verbatim, in their original order.\n\n"
            body += "\n".join("\n".join(b) for b in blocks) + "\n"
            write_atomic(f, body)

        while new_section and not new_section[-1].strip():
            new_section.pop()
        out = lines[:h + 1] + new_section + [""] + lines[end:]
        write_atomic(ctx, "\n".join(out).rstrip() + "\n")
    except OSError as exc:
        print(f"split-context: failed: {exc}", file=sys.stderr)
        return 1
    print(f"split-context: migrated {len(todo)} project(s); backup at {backup}; "
          f"CONTEXT.md {sum(len(l) + 1 for l in lines)}B -> {ctx.stat().st_size}B")
    return 0


if __name__ == "__main__":
    sys.exit(main())
