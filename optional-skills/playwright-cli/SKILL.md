---
name: playwright-cli
description: Disk-based Playwright QA scan for a running dev server or deployed site — screenshots, console-error capture, page-error capture, and same-origin link checks in one process with one compact report. Use this instead of an interactive Playwright-MCP navigate/snapshot loop whenever you're verifying a KNOWN site you (or a build pipeline) control — confirming a change renders, checking a build for console errors, screenshotting routes at multiple viewports, or catching broken internal links. Not for driving an unfamiliar third-party page (a competitor site, a social profile, a SaaS UI you don't control the markup of) or anything needing live interaction (click, fill, drag) — that's still Playwright MCP.
---

# Playwright CLI — disk-based frontend QA

One bash call, one compact text report, screenshots on disk. Replaces the
`browser_navigate` -> `browser_snapshot` -> `browser_take_screenshot` -> repeat
MCP loop for the common case: a site whose DOM you already control (your own
build, a scaffold, any local dev server) and you just need to confirm it
renders clean.

**Why this exists over MCP:** MCP's snapshot-per-step loop pays a full
accessibility-tree or screenshot round-trip in tokens for every single action.
A scripted Playwright run does the whole navigate-render-capture cycle for
every route x viewport in one process and returns a handful of text lines.
Screenshots land on disk — `Read` the PNG directly instead of paying for an
MCP image round-trip.

**When to still use Playwright MCP instead:** driving a page you don't control
the markup of (a competitor site, a social-profile scrape, any external SaaS
UI), or anything that needs live interaction — click a button, fill a form,
drag, handle a dialog, and see what happens next. This skill only navigates
and observes; it does not interact.

## Setup (one-time)

```bash
cd "${CLAUDE_PLUGIN_ROOT}/skills/playwright-cli" && npm install
```

Pinned to `playwright@1.58.0`. If you already have the `playwright` CLI
installed globally at the same version, this reuses its already-downloaded
Chromium (`~/Library/Caches/ms-playwright/` on macOS) instead of pulling a
second copy.

## Run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/playwright-cli/scripts/scan.mjs" <base-url> [options]
```

The target must already be reachable — start the dev server first (`npm run
dev`, `vite preview`, or a deployed URL). This script does not manage a dev
server for you; it just drives Playwright against whatever URL you give it.

| Option | Default | Notes |
|---|---|---|
| `--routes /,/about,/contact` | `/` | Comma-separated paths, checked at every viewport |
| `--viewports mobile:375x812,desktop:1280x800` | shown | `name:WxH` pairs, comma-separated |
| `--out <dir>` | `./qa-out` | Screenshot output directory |
| `--locale <locale>` | `en-US` | Browser locale — e.g. `he-IL` for a Hebrew RTL site |
| `--no-links` | links on | Skip the same-origin link check |
| `--no-screenshots` | screenshots on | Console/link checks only, faster |

Exit codes: `0` clean, `1` issues found (console error, page error, failed
nav, or broken link), `2` usage/runtime error.

### Example

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/playwright-cli/scripts/scan.mjs" http://localhost:5173 \
  --routes /,/about,/contact
```

Output is terse:

```
QA SCAN: http://localhost:5173
Routes: /, /about, /contact  x  Viewports: mobile(375x812), desktop(1280x800)

/            mobile    OK
/            desktop   OK
/about       mobile    FAIL
  console  TypeError: Cannot read properties of undefined (reading 'map')
/contact     desktop   OK

Links checked: 14, broken: 1
  FAIL https://.../old-promo -> 404

Screenshots: ./qa-out/ (6 files)

VERDICT: FAIL — 2 issue(s)
```

Then `Read` the screenshot files listed under `Screenshots:` for the visual
pass — this is the step that still needs a human or a design-judgment skill
to look; this tool only proves the page didn't error.

## What this does NOT replace

- **Visual/design judgment.** This catches console errors, dead links, and
  failed navigations — it has no opinion on whether the layout looks good.
  Screenshots still need eyes, yours or a design-review skill's.
- **Contrast/accessibility checking.** If your project has a dedicated
  contrast-checking tool, run that separately — this skill doesn't duplicate it.
- **Interactive flows.** Login, checkout, form submission, drag-and-drop —
  anything that needs to act and then observe the result stays on Playwright
  MCP (or a hand-written Playwright script for that one flow).
- **Unfamiliar third-party pages.** Scraping a lead's social profile or a
  competitor's site is a different problem (unknown DOM, needs visual
  judgment while scrolling) — that stays MCP-driven.
