# Contributing

Issues and pull requests are welcome. A few things worth knowing before you
open one.

## Reporting a bug

The most useful bug report for this project answers three questions:

1. **What did the plugin do, and what did you expect instead?**
2. **What does `<hub>/jarvis-config.json` look like?** (redact any paths you'd
   rather not share — the shape is what matters)
3. **Did `/jarvis-setup` report an error, or did it look like it worked?**

That third one matters more than it sounds. This plugin's worst failure class
is silent: setup succeeds, nothing errors, and memory just never loads. If
something looks fine but isn't working, say so — that's a real report, not a
vague one.

Do **not** paste API keys, tokens, or the contents of `<hub>/.env` into an
issue.

## Proposing a skill

Skills are the easiest thing to contribute and the easiest to get wrong. Two
hard requirements:

**License.** If you didn't write it, it needs a license that permits
redistribution under MIT, verified from the **primary source** — the actual
LICENSE file in the repo or package, not a blog post or a README claim.
"No LICENSE file" means no grant, not "probably fine". Copyleft licenses
(AGPL, GPL) can't be bundled here; they can be recommended as separate
installs.

**Genericity.** A skill in this repo runs on a stranger's machine. That means
no hardcoded home directories, no references to a vault layout only you have,
no assumed CLI that isn't declared, and no language other than English in the
shipped text. If your skill needs a user-specific value, read it from
`<hub>/jarvis-config.json` or the environment.

## Testing a change

Unit-testing the pieces is not enough here, and this project has the scar to
prove it: the hook read a pointer file that no code ever wrote, and the server
created a hub it never seeded. Both halves passed their own tests. Together
they meant a user completed setup successfully and got nothing.

So before you open a PR, **walk the whole first-run path on a clean state**:

```bash
export HOME=/tmp/jarvis-test-home   # in a throwaway shell, not your real one
mkdir -p "$HOME"

node hooks/session-start.mjs        # expect: the not-configured nudge, exit 0
node setup/server.mjs               # then POST /api/config with a fresh hub path
node hooks/session-start.mjs        # expect: MEMORY.md actually loads
```

Then do it once more with a hand-edited `MEMORY.md` already in the hub and
confirm it is **not** overwritten.

Say in the PR what you actually ran and what you saw. "Should work" is not a
test result.

## Style

- Shipped text is English. Comments explain *why*, not *what*.
- No new dependencies in `hooks/` or `setup/` — both are deliberately plain
  Node with zero installs, because a memory hook that needs `npm install` to
  run is a memory hook that will fail on someone's machine.
- Don't add telemetry, analytics, or a phone-home of any kind. This isn't
  negotiable.
