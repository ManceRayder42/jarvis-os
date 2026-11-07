#!/usr/bin/env node
// jarvis-os session-recall: search past sessions. No model call.
//
// Usage: node search.mjs <term> [more terms] [--all] [--limit N] [--notes-only]
//
// 1. Staging notes in <hub>/staging/session-notes/ (filename + matching line).
// 2. Past Claude Code transcripts of the current project (--all: every
//    project): user prompts and assistant text only, never tool results.
//    Snippets are secret-redacted.
import fs from 'node:fs';
import path from 'node:path';
import { blocks, claudeProjectsDir, isNoise, projectDirFor, readJsonl, redact, resolveHub, stagingDir } from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const li = argv.indexOf('--limit');
const LIMIT = li >= 0 ? parseInt(argv[li + 1], 10) || 8 : 8;
const terms = argv.filter((a, i) => !a.startsWith('--') && !(li >= 0 && i === li + 1)).map((t) => t.toLowerCase());
if (!terms.length) { console.log('usage: search.mjs <terms...> [--all] [--limit N] [--notes-only]'); process.exit(2); }

function listJsonl(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  } catch (e) { return []; }
}

// --- notes
const hub = resolveHub();
let noteHits = 0;
if (hub) {
  const dir = stagingDir(hub);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse(); } catch (e) {}
  for (const n of names) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(dir, n), 'utf8'); } catch (e) { continue; }
    const low = txt.toLowerCase();
    if (!terms.every((t) => low.includes(t))) continue;
    const line = txt.split('\n').find((l) => l.toLowerCase().includes(terms[0])) || '';
    console.log('[note] ' + n + '\n   ' + redact(line.trim()).slice(0, 300));
    if (++noteHits >= LIMIT) break;
  }
}
if (!noteHits) console.log('no staging note matched: ' + terms.join(' '));
if (flag('--notes-only')) process.exit(0);

// --- transcripts
let files = [];
if (flag('--all')) {
  try {
    for (const d of fs.readdirSync(claudeProjectsDir())) files.push(...listJsonl(path.join(claudeProjectsDir(), d)));
  } catch (e) {}
} else {
  files = listJsonl(projectDirFor(process.cwd()));
}
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } };
files.sort((a, b) => mtime(b) - mtime(a));

const hits = [];
for (const f of files) {
  const sid = path.basename(f, '.jsonl');
  let best = null;
  try {
    for (const d of readJsonl(f)) {
      if ((d.type !== 'user' && d.type !== 'assistant') || d.isSidechain) continue;
      for (const b of blocks((d.message || {}).content)) {
        if (b.type !== 'text') continue;
        const txt = String(b.text || '');
        if (isNoise(txt)) continue;
        const low = txt.toLowerCase();
        if (!low.includes(terms[0])) continue;
        const score = terms.reduce((s, t) => s + low.split(t).length - 1, 0);
        if (!best || score > best.score) {
          const i = low.indexOf(terms[0]);
          best = { score, ts: d.timestamp || '', role: d.type, snip: txt.slice(Math.max(0, i - 200), i + 300).replace(/\s+/g, ' ') };
        }
      }
    }
  } catch (e) { continue; }
  if (best) hits.push({ ...best, sid });
  if (hits.length >= LIMIT * 3) break;
}
hits.sort((a, b) => (a.ts < b.ts ? 1 : -1));
for (const h of hits.slice(0, LIMIT)) {
  const day = h.ts ? String(h.ts).slice(0, 10) : '?';
  console.log('[' + day + '] session ' + h.sid.slice(0, 8) + ' (' + h.role + ', hits=' + h.score + ')\n   ' + redact(h.snip));
}
if (!hits.length) console.log('no transcript text matched: ' + terms.join(' '));
