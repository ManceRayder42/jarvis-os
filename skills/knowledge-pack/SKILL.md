---
name: knowledge-pack
description: Build a durable knowledge pack in the hub for one subject — a small always-read index plus numbered load-on-demand files, every claim sourced and graded. Use when the user says "build a knowledge pack", "make a reference on X", or when you notice you keep re-deriving or re-researching the same subject across sessions.
---

# Knowledge pack

A knowledge pack is a folder of markdown holding what is worth knowing about one
subject, arranged so a later session loads only the part it needs. A single rule
file has to be either short enough to always load or deep enough to be worth
writing. A pack is both: a tiny index that is always read, and large files read
only when the task touches them.

## When it earns its place

Only when something keeps being re-derived: a design system's rules, a compliance
regime, a vendor's API quirks, a market you serve. If nothing re-derives it, a
single hub note is enough. Check the hub first for an existing pack or note.

## Layout (in the hub, e.g. `<hub>/knowledge/<subject>/`)

```
index.md          the spine and routing table; always read first
01-<topic>.md     one file per sub-domain, numbered in reading order
NN-<topic>.md
sources.md        every source, with its tier and how to re-fetch it
```

## File contract

Frontmatter on every file:

```yaml
---
name: <kebab-case, matches filename>
description: <one line: what this file knows>
read-when: <a concrete trigger, e.g. "before choosing a payment flow">
tier-key: <what A/B/C mean in this file>
---
```

Body rules:

1. Operational register: rules that can be applied and checked. No essays.
2. Numbers over adjectives. If a rule can carry a number, it must.
3. Every claim carries a source URL and an evidence tier: A = primary source or
   standards body, B = replicated practitioner consensus, C = single unsourced claim.
4. Never invent a number. A widely repeated statistic you cannot source is recorded
   as folklore; that is a finding.
5. Say where evidence is thin. Flag contradictions between good sources; do not
   average them.

## Procedure

1. Scope the subject and split it into 5 to 9 sub-domains. Fewer files are too
   coarse to load selectively; more and the router is not memorable.
2. Fan out one research sub-agent per sub-domain, in a single message. Give each:
   its sub-domain, the file contract above, the target filename, and a deliverable
   shape (the file, the evidence for its key claims, and a "What I did not check"
   section). They need no coordination; the contract is the coordination.
3. Review each file against the contract: sourced, tiered, numeric, honest about
   gaps. Send back any that fail, with the failed rule named.
4. Write `index.md` last: a short summary of the subject, the routing table
   (question to file), and the list of files with their `read-when` lines.
5. Add one line to the hub's `MEMORY.md` pointing at the pack's `index.md`.

## Using a pack

Reference the pack's `index.md` at the decision point and the specific numbered file
at the step that needs it. Never paste pack content into a skill; copies go stale.
Use the pack to decide and a tool or test to verify.
