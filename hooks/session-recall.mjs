#!/usr/bin/env node
// jarvis-os — session-recall hook (EXPERIMENTAL, OPT-IN)
//
// One script for two events, told apart by `hook_event_name` on stdin:
//   SessionEnd   -> start a detached worker that writes a session note into
//                   <hub>/staging/session-notes/ (propose-only).
//   SessionStart -> print a short index of recent sessions in this project.
//
// Registered for every user, so it MUST be a no-op unless the user opted in
// (see optional-skills/recall/SKILL.md). Rules this file follows:
//   - opt-in is checked BEFORE stdin is read or anything else is loaded;
//   - it never throws and always exits 0, on every path;
//   - it returns fast: the SessionEnd worker is a detached child, the hook
//     never waits for it, and never calls a model itself.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'optional-skills', 'recall', 'scripts');

function done() { process.exit(0); }
// Safety net: never hang the session, whatever happens.
setTimeout(done, 4000).unref();

function optedInHub() {
  // Inline on purpose (mirrors scripts/lib.mjs) so the no-op path loads nothing.
  const env = (process.env.JARVIS_SESSION_RECALL || '').trim().toLowerCase();
  if (env === '0' || env === 'false') return null;
  let hub = null;
  const fromEnv = (process.env.JARVIS_HUB || '').trim();
  if (fromEnv) {
    hub = fromEnv;
  } else {
    try {
      const p = path.join(os.homedir(), '.jarvis-hub-path');
      if (fs.lstatSync(p).isFile()) hub = fs.readFileSync(p, 'utf8').trim() || null;
    } catch (e) { /* not configured */ }
  }
  if (!hub) return null;
  if (hub === '~' || hub.startsWith('~/') || hub.startsWith('~\\')) hub = path.join(os.homedir(), hub.slice(2));
  if (env === '1' || env === 'true') return hub;
  try {
    return fs.lstatSync(path.join(hub, '.session-recall')).isFile() ? hub : null;
  } catch (e) { return null; }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const t = setTimeout(() => resolve(data), 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; if (data.length > 1e6) { clearTimeout(t); resolve(data); } });
    process.stdin.on('end', () => { clearTimeout(t); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(data); });
  });
}

function onSessionEnd(hub, input) {
  if (process.env.JARVIS_RECALL_WORKER) return; // the worker's own `claude -p` ends a session too
  const transcript = String(input.transcript_path || '');
  if (!transcript.endsWith('.jsonl') || !fs.existsSync(transcript)) return;
  // Never summarize sessions that ran inside the hub itself (memory upkeep, setup).
  const cwd = String(input.cwd || '');
  if (cwd) {
    const rel = path.relative(path.resolve(hub), path.resolve(cwd));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return; // '' (the hub itself) or a subfolder
  }
  const worker = path.join(SCRIPTS, 'worker.mjs');
  if (!fs.existsSync(worker)) return;
  const child = spawn(process.execPath,
    [worker, transcript, String(input.session_id || ''), String(input.reason || ''), hub],
    { detached: true, stdio: 'ignore', env: { ...process.env, JARVIS_RECALL_WORKER: '1' } });
  child.on('error', () => {});
  child.unref();
}

async function onSessionStart(hub, input) {
  if (process.env.JARVIS_RECALL_WORKER) return;
  const { projectDirFor, stagingDir, redact } = await import(pathToFileURL(path.join(SCRIPTS, 'lib.mjs')).href);
  const cwd = String(input.cwd || process.cwd());
  const current = String(input.session_id || '');
  const dir = projectDirFor(cwd);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { p, sid: f.slice(0, -6), mtime: st.mtimeMs, size: st.size };
    });
  } catch (e) { return; }
  files.sort((a, b) => b.mtime - a.mtime);

  const noted = new Set();
  try {
    for (const n of fs.readdirSync(stagingDir(hub))) {
      const m = /^\d{4}-\d{2}-\d{2}-(.+)\.md$/.exec(n);
      if (m) noted.add(m[1]);
    }
  } catch (e) { /* no staging dir yet */ }

  const out = [];
  for (const f of files) {
    if (f.sid === current || f.size < 20000) continue;
    const prompt = redact(firstPrompt(f.p));
    if (!prompt) continue;
    const d = new Date(f.mtime);
    const day = String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    out.push('- ' + day + ' [' + f.sid.slice(0, 8) + ', ' + (noted.has(f.sid.slice(0, 8)) ? 'note' : 'no note') + '] ' + prompt);
    if (out.length >= 6) break;
  }
  if (out.length) {
    process.stdout.write('Recent sessions in this project (index only, not verified; use the recall skill for details):\n' + out.join('\n') + '\n');
  }
}

function firstPrompt(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const lines = buf.toString('utf8', 0, n).split('\n').slice(0, 400);
    for (const line of lines) {
      let d;
      try { d = JSON.parse(line); } catch (e) { continue; }
      if (d.type !== 'user' || d.isSidechain) continue;
      const c = (d.message || {}).content;
      const parts = typeof c === 'string' ? [c] : (Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text) : []);
      for (let t of parts) {
        t = String(t || '').trim();
        if (t && !/^(<|Caveat:|\[Request)/.test(t)) return t.replace(/\s+/g, ' ').slice(0, 130);
      }
    }
  } catch (e) { /* unreadable */ }
  return '';
}

try {
  const hub = optedInHub();
  if (hub) {
    let input = {};
    try { input = JSON.parse(await readStdin()) || {}; } catch (e) { input = {}; }
    const event = input.hook_event_name;
    if (event === 'SessionEnd') onSessionEnd(hub, input);
    else if (event === 'SessionStart') await onSessionStart(hub, input);
  }
} catch (e) {
  // Never let this hook break a session.
}
done();
