#!/usr/bin/env node
// jarvis-os session-recall: detached worker. Started by hooks/session-recall.mjs
// at SessionEnd, never run in the foreground of a session.
//
// Usage: node worker.mjs <transcript.jsonl> <session_id> <reason> <hub>
//
// digest -> ONE `claude -p` call -> note in <hub>/staging/session-notes/.
// It never writes anywhere else (propose-only: the user promotes a note by
// hand). Safe to re-run: the note file is overwritten per session id.
// Always exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDigest } from './extract.mjs';
import { safeId, stagingDir } from './lib.mjs';

process.env.JARVIS_RECALL_WORKER = '1'; // recursion guard: our own `claude -p` fires SessionEnd too

const [transcript, rawSid, reason = '', hub] = process.argv.slice(2);
const sid = safeId(rawSid) || 'unknown';
const TIMEOUT_MS = 5 * 60 * 1000;

function log(msg) {
  try {
    const dir = path.join(hub, 'staging');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'session-recall.log'),
      new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + sid.slice(0, 8) + ' ' + msg + '\n');
  } catch (e) { /* nowhere to log */ }
}

const PROMPT = `You write a short session note from a digest of a Claude Code session. Rules:
- Write in the language the USER mostly used. Section headers stay in English.
- At most 300 words. Do not invent anything that is not in the digest. If unsure, leave it out.
- Separate WHO decided: write "User decided:" only when the user clearly chose; write "Assistant recommended:" for the assistant's own suggestions or choices the user did not confirm.
- Anything about the CURRENT STATE of a system, account, plan, price or file (e.g. "X is on plan Y", "job Z is disabled") must be tagged "(said in session, not verified now)".
- Do not copy secrets, tokens, passwords or personal data.
Output exactly this markdown, nothing before or after:

# <3-7 word title>
**Goal:** <one sentence>
**Takeaway:** <the single most important thing for the next session>
## Decisions
- ...
## Open threads
- ...
## Next prompt
<2-4 sentences the user could paste to resume this work>

DIGEST:
`;

function runClaude(input) {
  return new Promise((resolve) => {
    const model = /^[A-Za-z0-9._\[\]-]{1,60}$/.test(process.env.JARVIS_RECALL_MODEL || '') ? process.env.JARVIS_RECALL_MODEL : 'sonnet';
    const bin = process.env.JARVIS_CLAUDE_BIN || 'claude';
    const args = ['-p', '--model', model, '--effort', 'low', '--no-session-persistence', '--tools', '', '--setting-sources', 'project'];
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, shell: process.platform === 'win32' });
    } catch (e) { return finish({ code: -1, out, err: String(e.message) }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} finish({ code: -2, out, err: 'timeout' }); }, TIMEOUT_MS);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => finish({ code: -1, out, err: String(e.message) }));
    child.on('close', (code) => finish({ code, out, err }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function main() {
  if (!transcript || !hub) return;
  if (!fs.existsSync(transcript)) { log('no transcript: ' + transcript); return; }

  let digest;
  try {
    digest = buildDigest(transcript);
  } catch (e) { log('extract failed: ' + e.message); return; }
  if (digest.tooSmall) { log('skip: session too small (reason=' + reason + ')'); return; }

  const r = await runClaude(PROMPT + digest.text + '\n');
  const result = r.out.trim();
  if (r.code !== 0 || !result) {
    log('claude failed rc=' + r.code + (r.err ? ' ' + r.err.trim().split('\n').slice(-2).join(' | ').slice(0, 300) : ''));
    return;
  }

  const day = new Date().toISOString().slice(0, 10);
  const outDir = stagingDir(hub);
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, day + '-' + sid.slice(0, 8) + '.md');
  const note = ['---', 'type: session-auto', 'date: ' + day, 'session: ' + sid,
    'end-reason: ' + String(reason).replace(/[^A-Za-z0-9_-]/g, ''),
    'status: staging (auto-written, not reviewed)', '---', '', result, ''].join('\n');
  const tmp = out + '.tmp' + process.pid;
  fs.writeFileSync(tmp, note);
  fs.renameSync(tmp, out);
  log('wrote ' + out);
}

main().catch((e) => log('worker error: ' + e.message)).finally(() => process.exit(0));
