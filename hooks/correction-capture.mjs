#!/usr/bin/env node
// shufi: UserPromptSubmit hook. A correction becomes a rule in one step.
//
// When your message sounds like a correction of how Claude behaves ("no, I said...", "stop doing...",
// "לא, אמרתי...", "תפסיק..."), this adds ONE short instruction (~80 tokens) to that turn: write or
// update a feedback rule in your hub now, then confirm in one line. The only step for you is the
// correction you already typed; "undo" removes the rule.
//
// Safe by construction: model-free, no network, no subprocess, fails open (always exit 0, never
// blocks the prompt). Silent when there is no hub, the hub has no MEMORY.md, or the message is
// not a correction. At most once every N prompts per session (default 4).
//
// Off switches: env JARVIS_CORRECTION_CAPTURE=0, or an empty file <hub>/.correction-capture.off
// Tuning: env JARVIS_CORRECTION_COOLDOWN=<N prompts>
// Detection rules and the Hebrew prefix handling: hooks/lib/correction-core.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHub, hubIsSetUp, exists } from './lib/hub.mjs';
import { unwrapPrompt, detectCorrection, buildInstruction } from './lib/correction-core.mjs';

const DEFAULT_COOLDOWN = 4;
const STATE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function done() { process.exit(0); }
setTimeout(done, 2500).unref(); // never hang a prompt

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const t = setTimeout(() => resolve(data), 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; if (data.length > 2e6) { clearTimeout(t); resolve(data); } });
    process.stdin.on('end', () => { clearTimeout(t); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(data); });
  });
}

function stateDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  return process.env.JARVIS_STATE_DIR || path.join(os.tmpdir(), 'shufi-' + uid);
}

function stateFile(sid) {
  return path.join(stateDir(), 'correction-' + (String(sid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'default') + '.json');
}

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && Number.isFinite(s.n)) return { n: s.n, last: Number.isFinite(s.last) ? s.last : null, fresh: false };
  } catch (e) { /* new session */ }
  return { n: 0, last: null, fresh: true };
}

function saveState(file, s) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ n: s.n, last: s.last }));
  } catch (e) { /* cooldown is best effort */ }
}

function prune(dir) {
  try {
    const cutoff = Date.now() - STATE_MAX_AGE_MS;
    for (const n of fs.readdirSync(dir)) {
      if (!n.startsWith('correction-')) continue;
      const p = path.join(dir, n);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch (e) { /* skip */ }
    }
  } catch (e) { /* best effort */ }
}

async function main() {
  const off = (process.env.JARVIS_CORRECTION_CAPTURE || '').trim().toLowerCase();
  if (off === '0' || off === 'off' || off === 'false') return;
  const hub = resolveHub();
  if (!hubIsSetUp(hub) || exists(path.join(hub, '.correction-capture.off'))) return;

  let input = {};
  try { input = JSON.parse(await readStdin()) || {}; } catch (e) { return; }
  const text = unwrapPrompt(input.prompt);
  if (!text) return;

  const cooldown = Math.max(1, parseInt(process.env.JARVIS_CORRECTION_COOLDOWN, 10) || DEFAULT_COOLDOWN);
  const file = stateFile(input.session_id);
  const st = loadState(file);
  st.n += 1;
  const hit = detectCorrection(text);
  const fire = !!hit && (st.last === null || st.n - st.last >= cooldown);
  if (fire) st.last = st.n;
  saveState(file, st);
  if (st.fresh && st.n === 1) prune(path.dirname(file));
  if (fire) process.stdout.write(buildInstruction(hub, os.homedir()));
}

try { await main(); } catch (e) { /* fail open */ }
done();
