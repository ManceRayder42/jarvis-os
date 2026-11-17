---
name: shufi-design
description: The design process Shufi itself was built with — turns a vague UI ask into 5-7 live, clickable direction prototypes built from the user's own references, compared in one tabbed artifact, then narrowed round by round. Use for any new site, landing page, setup flow, app screen or redesign where the look is not decided yet, or when the user says a design looks like "AI slop" or "generic", or asks for options/directions. Not for small tweaks to an approved design.
---

# Shufi-Design

**This is how Shufi was designed, and it is Shufi custom.** The setup page started as one
generic design the owner called "AI slop". This process took it to designs they loved in
three rounds. The process is the asset, not those designs.

## Round 0 — references before pixels (never skip)
1. **The user's own references:** bookmarks folder, saved links, screenshots, sites they name.
   Ask for them if none are given. Open the demos in a real browser and look at them.
2. **Brand design systems** the user likes (a `DESIGN.md` per brand, if they keep one).
3. **Taste memory:** any saved feedback on colour, density, desktop vs phone. Read it first.
4. **The subject's own world:** what is unique to this product (a mascot, a material, a
   metaphor). The one thing that already feels designed is the seed; build the world around it.
5. Paid reference libraries: skip unless the user already has the plan.

## Round 1 — 6 directions, built, not described
- Write ONE shared `BRIEF.md`: product, real content (no lorem), assets, palette baseline,
  banned looks (navy cards + glow rings, pills everywhere, gradient blobs, emoji, left-accent
  cards, everything centered, cream + terracotta serif), "one strong idea per direction".
- Write a `FEATURES.md` from the real source (code/README). Never claim a feature that
  does not ship.
- Spawn agents in parallel, **2 directions each**. Each direction = a self-contained working
  HTML prototype where the key interaction actually plays.
- Every agent verifies itself: browser screenshots at 1440x900, 1920x1080, 1280x800, 0
  console errors, no overflow, plus a mandatory "What I did not check".
- **Desktop first.** Phone width only if the product is a phone product.

## Present
- Start from `templates/index.html` in this skill folder (working tabbed gallery with a
  full-screen button; replace the `D` list with this project's directions).
- ONE tabbed artifact: `const D=[[id,label,note],...]` → iframe per direction, one-line note
  each, newest round on top, an in-page **Open full screen** button (links to new tabs are
  blocked in artifacts).
- Also serve the folder locally (`python3 -m http.server 8799 --bind 127.0.0.1`) and open
  each option full page when asked.
- Verify the live artifact in a browser before announcing it.
- Same link for every round. Mark unverified work "(draft)".

## Rounds 2+ — narrow by their words
- Save every verdict to memory (what they loved, what was "nice but less beautiful").
- Next round = combine the specific elements they named, 4-7 new versions, same brief file
  plus a short `BRIEF-R<n>.md`.
- Keep favourites untouched; build new files next to them.
- Past ~500k context: write `HANDOFF-R<n>.md` (paths, favourites, requests, publish steps)
  and continue in a fresh session.

## Direction menu (starting points — pick 6 that fit, invent new ones)
Material world (felt/paper/wood workbench) · Apple gallery (product-photo tiles, one action
colour) · 3D turning wall + giant marquee type · Night desk (one lamp, pointer lights
content, SVG-mask reveals) · Field guide / museum catalogue plates · Conversation-first
(calm, Raycast/Superhuman) · Chat + live canvas that draws itself · Mac Messages app ·
Night sky / constellations · Tree that grows · Floating cards with parallax · App window
with sidebar + inspector · Crafting table top-down.

## Pitfalls already hit
- Artifact publish only accepts files under the current session's working dir: copy first.
- `<a target=_blank>` to a sibling file does nothing inside an artifact; use in-page full screen.
- A centered 620px chat column reads as a phone app on desktop. Use the width.
- `position:relative` on a shared class silently breaks absolutely-placed labels/buttons:
  screenshot every step, not just the first.
- Background agents die with the session: keep briefs and handoffs on disk.
- Code-drawn mascots replacing a loved photo/illustration were rejected ("scary"): keep the
  original art unless asked.

## Rules that made it work
- One bold idea per direction; everything else quiet. 60/30/10 colour.
- Real assets only (the user's photos/brand), never AI-drawn stand-ins they did not approve.
- Interaction beats static mock: judge motion and flow, not screenshots.
- Never pick the direction yourself; give options, the user chooses.
