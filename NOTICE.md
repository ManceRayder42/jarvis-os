# Attribution

This plugin is MIT (see LICENSE). Several of the skills it bundles were
written by other people and are included under their own MIT terms,
unmodified in substance:

- **defuddle** — Steph Ango, MIT. Source: `github.com/kepano/obsidian-skills`.
- **qmd** — Tobi Lütke, MIT. Source: `github.com/tobi/qmd`. The bundled copy is
  a trimmed fork of v2.0.0; upstream has moved on to 2.2.0. Same tool and scope,
  shorter prose. If you want the current text, install from upstream.
- **obsidian-markdown**, **obsidian-bases**, **json-canvas**, **obsidian-cli**
  — Steph Ango, MIT. Same source as `defuddle`: `github.com/kepano/obsidian-skills`.
  These four are optional — they only appear once you enable Obsidian support
  (Obsidian is detected, or absent that, you turn them on yourself), since
  they're dead weight in every session's skill list for anyone without
  Obsidian. See the README's "Optional skills" section.

## Recommended, but NOT bundled

These are genuinely good and worth installing — they are left out for license
reasons, not quality ones.

- **llm-council** — runs a decision past five independent advisors and
  synthesizes a verdict. By [Ole Lehmann](https://github.com/aiwithremy/claude-skills-llm-council),
  after Andrej Karpathy's LLM Council. Its repository ships no license file,
  which means no grant to redistribute it. Install it yourself from the source
  above.
- **nano-banana** — image generation and editing, with a free tier. Licensed
  AGPL-3.0. AGPL is copyleft: bundling it would pull this entire plugin under
  AGPL, so it stays a separate install.

Nothing here phones home, and this plugin collects no telemetry.
