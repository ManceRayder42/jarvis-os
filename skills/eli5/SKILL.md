---
name: eli5
description: Explain any concept, codebase, or architecture like reader know nothing about it, as visual HTML artifact — big pictures, few words. Trigger on "/eli5 <topic>", "explain like I'm 5", "ELI5 this".
---

# ELI5 visual explainer

Anthropic internal pattern (Thariq, product lead, via [@trq212](https://x.com/trq212/status/2090884854590382515)). Source write-up: https://leslieli.dev/notes/anthropic-eli5-skill-html-artifacts/

Original prompt: *"Explain like I'm someone who knows nothing about this topic, using an HTML artifact with big pictures and few words."*

## Steps

1. Assume reader new to topic — no jargon without one-line definition.
2. Load `artifact-design` skill before writing (mandatory in this environment for any HTML artifact).
3. Build ONE self-contained HTML page: diagram or visual sequence first, minimal text. Add interactive control only when it reveals a state change or relationship — never as decoration.
4. Label assumptions plainly. A simplified diagram is illustration, not proof.
5. Publish via Artifact tool — title = topic name, favicon required.

Keep adaptation short. Source contributes the format constraint (big pictures, few words), not a house style or claim interaction always helps.
