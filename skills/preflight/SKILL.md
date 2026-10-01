---
name: preflight
description: Pre-deploy sanity check for environment files and project paths. Use when the user says /preflight, "preflight check", "audit env", "check env file", "deploy ready", "before deploy", or when auth or storage works locally but breaks in production. Catches literal backslash-n inside quoted dotenv values, trailing whitespace inside quoted values, non-ASCII working paths combined with Next.js, and empty catch blocks.
---

# Preflight

Run before a production deploy, before pushing a release branch, or whenever auth
or storage suddenly fails in production but works locally. It is an interactive
check, not a CI gate.

## Procedure

Run from the project root:

```bash
# 1. Literal \n inside a quoted env value (dotenv turns it into a real newline)
grep -nE '\\n"[[:space:]]*$' .env* 2>/dev/null

# 2. Trailing whitespace inside a quoted value
grep -nE '[[:space:]]+"$' .env* 2>/dev/null

# 3. Non-ASCII working directory with Next.js (the bundler can choke on it)
if [ -f package.json ] && jq -e '.dependencies.next // .devDependencies.next' package.json >/dev/null 2>&1; then
  pwd | LC_ALL=C grep -P '[^\x00-\x7F]' >/dev/null && echo "WARN: non-ASCII path + Next.js"
fi

# 4. Empty catch blocks (swallowed errors)
grep -rnE '\bcatch[[:space:]]*(\([^)]*\))?[[:space:]]*\{[[:space:]]*\}' src app pages 2>/dev/null | head -5
```

If `jq` or `grep -P` is missing on this machine, say so and skip that check rather
than reporting a pass.

## Output

One line per check, with `file:line` and a one-line fix for every failure:

```
preflight YYYY-MM-DD
[PASS] env: no literal \n in quoted values
[FAIL] env: .env.production:12 trailing whitespace inside quoted value
[PASS] path: ASCII-only working directory
[WARN] catch: src/api/upload.ts:42 empty catch block
```

## Fixes

- Literal `\n` in a quoted value: put the value on one line. A real newline inside
  a JWT or signed URL corrupts it.
- Trailing whitespace inside the quotes: strip it; most parsers keep it and the API
  then rejects the token.
- Non-ASCII path with Next.js: move the project to an ASCII-only path.
- Empty `catch {}`: at minimum log the error; better, surface it to the caller.

## When not to run

On a fresh repo with no env file yet, or as a CI gate (use a linter there).
