# Memory Index

_Routing index for your memory hub. Files are NOT auto-loaded in full — this
index is what the SessionStart hook injects into context. Keep entries to one
line each; the fact itself lives in the linked file._

_Last updated: (edit this whenever you add or change a memory)_

## User
- [Example User Fact](example-user-fact.md) — placeholder: replace with something true about you

## Project
- [Example Project Note](example-project-note.md) — placeholder: replace with an active project's context

## Feedback
- [Example Feedback Rule](example-feedback-rule.md) — placeholder: replace with a behavioral correction you've given Claude

## Reference
- (add pointers to external resources here — URLs, dashboards, tickets — as you collect them)

<!--
How this file works:

- One line per memory, format: `- [Title](filename.md) — one-sentence hook`.
- The hook is what a recall pass matches against, so make it specific enough
  to be useful, short enough to stay index-sized.
- Group by type (User / Project / Feedback / Reference) — matches the
  `metadata.type` field inside each linked file.
- This whole file gets injected into every session's context, so keep it
  lean. If it grows past ~8KB the SessionStart hook falls back to emitting
  only the header and list lines, not any prose you add around them — don't
  rely on commentary here being seen once you're past that size.
- Delete these three example files and their index lines once you've
  replaced them with your own memories.
-->
