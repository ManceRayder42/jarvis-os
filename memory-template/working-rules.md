---
name: working-rules
description: How Claude works here — delegation contract, model routing, retrieval order, brevity. Edit freely; this is your rulebook.
metadata:
  type: feedback
---

# How Claude works here

Plain rules, applied in every session. Edit them to match how you work.

## Roles

- The main session plans, delegates and reviews. Only the main session spawns
  agents; a sub-agent that finds more work returns a "Recommended follow-up"
  list instead of spawning.
- Never run agents one after another when they have no dependency on each
  other. Launch independent ones in a single message.

## Deliverable contract

Every delegated task states the shape of the answer. A report missing its
mandatory field is incomplete, not "close enough".

| Role | Must return |
|---|---|
| Main session | plan, current status, explicit exit criteria |
| Worker | the artifact, the evidence it works, and a section called "What I did not check" |
| Reviewer | approve / reject / ordered fix list, with a verdict per rubric criterion |

- "What I did not check" names untested paths, skipped files, assumptions taken
  on faith and anything unreachable. A worker that writes "nothing" is almost
  always wrong; push back once.
- A reviewer gets a rubric. "Review this" returns "looks good", which is useless.

## Before spawning agents

- Bound the scope first. If you cannot state the exit criteria, do not spawn yet.
- Give a worker the minimum tools the task needs. A worker with everything
  wanders, costs more and can act outside its brief.
- Do not split a conversational flow across agents: every handoff drops context.
  Agents are for independent, narrow, parallel work with a compact return.

## Splitting large work

Split by provable unit, not by layer. Each chunk needs its own build, its own
test and its own diff. "Frontend first, then backend" produces two halves
neither of which can be verified alone.

## Models and effort

- Main session on your strongest model: it plans and reviews.
- Workers that do real edits or synthesis: a mid-tier model, high effort.
- Mechanical lookups (find a file, list, read a known path, extract a field,
  classify a message): the smallest model at low effort. If the answer is a
  fact rather than a judgement, start here.
- Always set effort explicitly. The default differs between surfaces for the
  same model, so an unstated effort is an unknown.
- Long sessions are the cost multiplier, not the task count: every turn re-reads
  the whole context. Split early with a fresh session instead of dragging one on.

## New automations start propose-only

Any new scheduled job or unattended automation runs propose-only for its first
week: it does the work and writes what it would have done, and you read that
before it gets write access. Does not apply to a job that only reads and
reports, a one-off, or a change to an automation you already trust.

## Retrieval order

When answering a question about something already in the hub:

1. Hub notes first (the index, then the linked notes). Hand-curated, trusted.
2. Exact grep or a direct read when you know the literal word, file or symbol.
   It fails loudly and works on brand-new files.
3. Semantic search (the qmd skill, if installed) for fuzzy "find what I wrote
   about X" recall. It can return a confident wrong match, so do not use it for
   known tokens.
4. Follow the links between notes for "how does X relate to Y".
5. The web last, only once the above are exhausted.

## Style

- Short, action-oriented replies. Depth belongs in a file or a visual page, not
  a wall of bullets in chat.
- Brevity improves accuracy: no filler, no preamble, state the result.
- Do not claim a thing works until you have run it. Report what was verified and
  what was not.
