#!/usr/bin/env node
// jarvis-os: SessionStart memory check.
//
// Looks for stale or broken things in the hub (paths that no longer exist, MEMORY.md lines that
// point nowhere, files with no index line, `check:` lines that fail, overdue patterns.md records)
// and writes ONE report. It never edits memory and never calls a model.
//
//   - Runs at most once per 24h: the stamp is <hub>/.memory-check-stamp.
//   - Silent when clean. With findings it prints ONE line pointing at the report.
//   - Does nothing when no hub is configured, or the hub has no MEMORY.md yet.
//   - Stops scanning at ~150ms of wall time (process start included) and notes "partial".
//   - Always exits 0. A memory hook that breaks session start is worse than none.
//
// Off switches: env JARVIS_MEMORY_CHECK=0, or an empty file <hub>/.memory-check.off
// Manual run (ignores the stamp, always prints a result):  node hooks/memory-check.mjs --force
//
// Registered as its own SessionStart entry in plugin.json (not called from session-start.mjs):
// a slow or hung disk read here must never be able to delay or drop the memory load.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveHub, hubIsSetUp, exists } from './lib/hub.mjs';
import { checkMemory, renderReport, localDate } from './lib/memory-check-core.mjs';

const DAY_MS = 24 * 3600 * 1000;
const KEEP_REPORTS = 14;

function disabled(hub, env) {
  const v = (env.JARVIS_MEMORY_CHECK || '').trim().toLowerCase();
  if (v === '0' || v === 'off' || v === 'false') return true;
  return exists(path.join(hub, '.memory-check.off'));
}

function pruneReports(dir) {
  try {
    const old = fs.readdirSync(dir).filter((n) => /^memory-check-\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().slice(0, -KEEP_REPORTS);
    for (const n of old) fs.rmSync(path.join(dir, n), { force: true });
  } catch (e) { /* best effort */ }
}

// Returns the one line to print, or null for silence. Never throws.
export function runIfDue({ hub, home = os.homedir(), env = process.env, nowMs = Date.now(),
  force = false, startedAt = performance.now(), budgetMs = 150 } = {}) {
  try {
    if (!hubIsSetUp(hub)) return force ? '[jarvis-os] memory check: no hub with a MEMORY.md found' : null;
    if (!force && disabled(hub, env)) return null;

    const stamp = path.join(hub, '.memory-check-stamp');
    if (!force) {
      try {
        const age = nowMs - fs.statSync(stamp).mtimeMs;
        if (age >= 0 && age < DAY_MS) return null;
      } catch (e) { /* no stamp yet: due */ }
    }
    // Stamp first: two sessions starting together run once, and a hub we cannot write to stays silent.
    try { fs.writeFileSync(stamp, new Date(nowMs).toISOString() + '\n'); } catch (e) { return null; }

    const today = (env.JARVIS_MEMORY_CHECK_TODAY || '').trim() || localDate(new Date(nowMs));
    const res = checkMemory({ hub, home, today, budgetMs, startedAt });
    if (!res.findings.length) {
      return force ? '[jarvis-os] memory check: clean (' + res.stats.files + ' files' + (res.stats.partial ? ', partial scan' : '') + ')' : null;
    }
    const dir = path.join(hub, 'reports');
    const report = path.join(dir, 'memory-check-' + today + '.md');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(report, renderReport({ today, ...res }));
    } catch (e) { return null; } // no report to point at, so no notice
    pruneReports(dir);
    const n = res.findings.length;
    return '[jarvis-os] memory check: ' + n + ' possibly-stale item' + (n === 1 ? '' : 's') +
      ' → ' + report + (res.stats.partial ? ' (partial scan)' : '') + ' (ask me to fix them)';
  } catch (e) {
    return null;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const force = process.argv.includes('--force');
    const hub = resolveHub();
    const line = hub ? runIfDue({ hub, force, startedAt: 0 }) : (force ? '[jarvis-os] memory check: no hub configured' : null);
    if (line) process.stdout.write(line + '\n');
  } catch (e) { /* never break session start */ }
  process.exit(0);
}
