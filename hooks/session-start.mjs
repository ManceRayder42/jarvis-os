#!/usr/bin/env node
// jarvis-os — SessionStart hook
//
// Loads <hub>/MEMORY.md into every session's context, from any working
// directory. This exists because Claude Code's own auto-memory is keyed to
// git root and silently does not load outside it — the hub is a deliberate
// workaround, not a duplicate of that feature.
//
// Contract (verified against two real, working plugins before writing this):
//   - SessionStart hooks emit context by writing plain text to stdout. No
//     JSON envelope needed (confirmed in caveman's caveman-activate.js and
//     the official plugin-dev skill's load-context.sh example).
//   - stdin is NOT required. nano-banana's SessionStart hook (check_env.py)
//     never reads stdin at all and works in production. This hook has no
//     mid-session state to preserve (unlike caveman's mode flag), so it
//     re-reads the hub fresh every time and skips stdin entirely — simpler
//     and one less thing that can hang or throw.
//   - Hooks must be fast and must NEVER throw. A memory hook that breaks
//     session start is worse than no memory, so every failure path below
//     degrades to a silent `exit 0`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 8 * 1024;

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveHub() {
  // 1. Explicit override.
  const fromEnv = process.env.JARVIS_HUB;
  if (fromEnv && fromEnv.trim()) return expandHome(fromEnv.trim());

  // 2. Pointer file written by the setup server.
  const pointerPath = path.join(os.homedir(), '.jarvis-hub-path');
  try {
    if (fs.lstatSync(pointerPath).isFile()) {
      const raw = fs.readFileSync(pointerPath, 'utf8').trim();
      if (raw) return expandHome(raw);
    }
  } catch (e) {
    // Absent or unreadable — not configured.
  }
  return null;
}

function nudge() {
  process.stdout.write('[jarvis-os] Not set up yet — run /jarvis-setup to point this plugin at a memory hub.\n');
}

function emitMemory(hub) {
  const memoryPath = path.join(hub, 'MEMORY.md');
  let content;
  try {
    content = fs.readFileSync(memoryPath, 'utf8');
  } catch (e) {
    // Hub is configured but MEMORY.md isn't there yet (e.g. setup was
    // interrupted, or the hub was pointed somewhere without a seeded index).
    // Same one-line nudge as "unconfigured" — no separate nagging state.
    nudge();
    return;
  }

  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength <= MAX_BYTES) {
    process.stdout.write('# Jarvis memory (' + hub + '/MEMORY.md)\n\n' + content);
    return;
  }

  // Too big — emit only index lines (headers + list items), never truncate
  // mid-line or ship the full body over budget.
  const indexLines = content
    .split('\n')
    .filter((line) => /^\s*#/.test(line) || /^\s*[-*]\s/.test(line));

  let out = '# Jarvis memory index (' + hub + '/MEMORY.md — full file is '
    + Math.round(byteLength / 1024) + 'KB, over the ' + Math.round(MAX_BYTES / 1024)
    + 'KB session-start budget; showing index lines only)\n\n';
  out += indexLines.join('\n');
  process.stdout.write(out);
}

try {
  const hub = resolveHub();
  if (!hub) {
    nudge();
  } else {
    emitMemory(hub);
  }
} catch (e) {
  // Never let a memory hook break session start.
}

process.exit(0);
