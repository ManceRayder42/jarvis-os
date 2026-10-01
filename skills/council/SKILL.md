---
name: council
description: Pressure-test a real decision with several independent advisors, an anonymous peer review and a chair's verdict. Use when the user says "council this", "pressure-test this", "stress-test this", "which option", "I'm torn between", or presents a genuine tradeoff with stakes and more than one viable path. Do NOT use for factual lookups, simple yes/no questions, small tactical fixes or executing an already-approved plan.
---

# Council

One model asked for advice tends to agree with how the question was framed. This
skill gets around that: several advisors reason separately from different angles,
then judge each other's answers without knowing who wrote what, then a chair
writes the verdict. It costs real tokens, so it is for forks in the road only.

## When to use / not use

Use it for: choosing between approaches, validating an untested strategic plan,
direction-setting, anything where being wrong is expensive and nobody has argued
the other side.

Skip it for: lookups, "should I use tabs or spaces", reversible tactical calls,
or work whose plan is already approved. If the user did not state the options or
stakes, ask one clarifying question first; a vague question gives a vague verdict.

## Procedure

1. **Frame the question.** Write one paragraph: the decision, the options on the
   table, the constraints, what is at stake, and any facts the user gave. Pull
   relevant context from the hub or project files instead of asking when it exists.
   Every advisor receives exactly this paragraph and nothing else.
2. **Round 1: independent advisors.** Spawn five sub-agents in one message, each
   with the same framed question and a different lens:
   - Skeptic: how does this fail, and what is being assumed?
   - First-principles: ignore the framing; what problem is really being solved?
   - Upside: what is the larger version of this being missed?
   - Outsider: no domain knowledge; what looks confusing or unjustified?
   - Operator: what has to happen on Monday morning, and what is the first step?
   Tell each to answer in under 250 words, commit to a recommendation, and not to
   hedge. They must not see each other's output. Use a mid-tier model at high effort.
3. **Anonymize.** Shuffle the five answers and label them A to E. Strip the lens
   names so reviewers cannot tell who is who.
4. **Round 2: peer review.** Spawn five reviewers, each receiving all five
   anonymous answers. Each returns: the strongest answer and why, the weakest and
   why, and one thing every answer missed. Reviewers judge on evidence and reasoning,
   not on style.
5. **Chair.** The main session reads everything and writes the verdict:
   - where the advisors agree
   - where they genuinely clash, stated fairly
   - what the reviews flagged as blind spots
   - a recommendation, with the one thing that would change it
   - a single concrete next step
6. **Report in chat** as a short verdict. Save the full transcript to the hub only
   if the user asks or the decision is significant.

## Rules

- The chair may overrule the majority, but must say why.
- Never fabricate evidence to break a tie; say what is unknown instead.
- Cost note: this is roughly ten sub-agent runs plus synthesis. Say so before
  running it on a large context, and offer a three-advisor version for smaller calls.
