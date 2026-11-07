#!/usr/bin/env node
// jarvis-os session-recall: turn a Claude Code transcript (.jsonl) into a
// compact, secret-filtered digest. No model is called here.
//
// Usage: node extract.mjs <transcript.jsonl> [--max-chars 60000]
// Prints the digest to stdout. Exit 3 when the session is too small to be
// worth a note; exit 1 on any other error.
//
// Kept: real user prompts, assistant text, one-line tool summaries.
// Dropped: ALL tool results (file contents, command output, .env reads),
// attachments, system rows, sub-agent traffic. Key/token-shaped strings are
// replaced with [REDACTED] even inside kept text.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocks, clip, isNoise, readJsonl, redact } from './lib.mjs';

const MAX_USER = 1500;
const MAX_ASSIST = 1200;
const MIN_USER_MSGS = 5;

function fmtDay(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return String(ts);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function buildDigest(file, maxChars = 60000) {
  const lines = [];
  const commits = [];
  const edited = [];
  let userMsgs = 0, toolCalls = 0, firstTs = null, lastTs = null, cwd = null, sid = null;

  for (const d of readJsonl(file)) {
    if (d.timestamp) { firstTs = firstTs || d.timestamp; lastTs = d.timestamp; }
    cwd = cwd || d.cwd;
    sid = sid || d.sessionId;
    if ((d.type !== 'user' && d.type !== 'assistant') || d.isSidechain) continue;
    for (const b of blocks((d.message || {}).content)) {
      if (d.type === 'user' && b.type === 'text') {
        const txt = String(b.text || '');
        if (isNoise(txt)) continue;
        userMsgs++;
        lines.push('USER: ' + clip(redact(txt), MAX_USER));
      } else if (d.type === 'assistant' && b.type === 'text') {
        const txt = String(b.text || '');
        if (txt.trim()) lines.push('ASSISTANT: ' + clip(redact(txt), MAX_ASSIST));
      } else if (d.type === 'assistant' && b.type === 'tool_use') {
        toolCalls++;
        const name = b.name || '';
        const inp = b.input || {};
        if (name === 'Bash') {
          const cmd = redact(String(inp.command || ''));
          if (cmd.includes('git commit')) commits.push(clip(cmd.replace(/\n/g, ' '), 160));
          lines.push('TOOL Bash: ' + clip(cmd.replace(/\n/g, ' '), 110));
        } else if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
          const fp = String(inp.file_path || '');
          if (fp && !edited.includes(fp)) edited.push(fp);
          lines.push('TOOL ' + name + ': ' + fp);
        } else {
          lines.push('TOOL ' + name);
        }
      }
    }
  }

  if (userMsgs < MIN_USER_MSGS) return { tooSmall: true, userMsgs };

  let body = lines.join('\n');
  if (body.length > maxChars) {
    body = body.slice(0, Math.floor(maxChars * 0.25))
      + '\n[... middle of session omitted for length ...]\n'
      + body.slice(-Math.floor(maxChars * 0.75));
  }
  const meta = [
    'SESSION: ' + (sid || path.basename(file)),
    'CWD: ' + cwd,
    'FROM: ' + fmtDay(firstTs) + '  TO: ' + fmtDay(lastTs) + ' (UTC)',
    'USER MESSAGES: ' + userMsgs + '  TOOL CALLS: ' + toolCalls,
    'COMMIT COMMANDS: ' + (commits.length ? commits.slice(-8).join(' | ') : '(none seen)'),
    'FILES EDITED (first 15): ' + (edited.length ? edited.slice(0, 15).join(', ') : '(none)'),
    '---',
  ];
  return { tooSmall: false, text: meta.join('\n') + '\n' + body };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = process.argv[2];
    if (!file) { console.error('usage: extract.mjs <transcript.jsonl> [--max-chars N]'); process.exit(2); }
    const i = process.argv.indexOf('--max-chars');
    const max = i > 0 ? parseInt(process.argv[i + 1], 10) || 60000 : 60000;
    const r = buildDigest(file, max);
    if (r.tooSmall) { console.error('too small: ' + r.userMsgs + ' user messages'); process.exit(3); }
    process.stdout.write(r.text + '\n');
  } catch (e) {
    console.error('extract failed: ' + e.message);
    process.exit(1);
  }
}
