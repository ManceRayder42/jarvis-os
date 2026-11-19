// jarvis-os: memory checker, pure part. Model-free, no subprocess, no network, Node stdlib only.
//
//   checkMemory({ hub, home, today, budgetMs, startedAt }) -> { findings, hints, stats }
//   renderReport({ hub, today, findings, hints, stats })    -> markdown string
//
// It READS the hub and returns data. It never writes: hooks/memory-check.mjs writes the report.
// Ported from the Python checker used on the author's own memory; the precision rules are the point:
//   - only unambiguous paths are checked (absolute under a known root, ~/..., drive letter);
//     anything else path-shaped counts as "unresolvable" and is never reported;
//   - a missing path on a line that says moved/gone/archived is a history note: listed, not counted;
//   - `check:` is a closed vocabulary (exists, absent, grep). Anything else is reported, never run.

import fs from 'node:fs';
import path from 'node:path';

export const FS_ROOTS = new Set(['Users', 'home', 'tmp', 'private', 'opt', 'etc', 'var', 'usr',
  'Library', 'Applications', 'Volumes', 'bin', 'sbin', 'System', 'mnt', 'srv', 'root']);

// Plugin-owned or consolidation-owned files at the hub top level. They hold history, so they
// are never "memory records": no unindexed check, no dead-path scan.
export const SYSTEM_FILES = new Set(['memory.md', 'context.md', 'patterns.md', 'conversation-log.md', 'readme.md']);

// Plugin-owned hub files that session-start loads directly, so they have no MEMORY.md line and must
// not be reported as unindexed (hubs created before working-rules.md existed never got one).
export const UNINDEXED_OK = new Set(['working-rules.md']);

export const TYPES = ['dead_path', 'dangling_index', 'unindexed', 'check_failed', 'check_invalid',
  'review_overdue', 'malformed'];

const TITLES = {
  dead_path: 'A path in a memory file does not exist',
  dangling_index: 'MEMORY.md links to a file that is missing',
  unindexed: 'A memory file has no line in MEMORY.md',
  check_failed: 'A `check:` line did not hold',
  check_invalid: 'A `check:` line is not in the allowed vocabulary (never run)',
  review_overdue: 'A patterns.md record is past its review date',
  malformed: 'A patterns.md record is missing claim, evidence or review',
};

const MAX_FILE_BYTES = 256 * 1024;
const MAX_GREP_BYTES = 1024 * 1024;

const SPAN_RE = /`([^`\n]+)`/g;
const LINK_RE = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const WIKI_RE = /\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g;
const DATE_RE = /\d{4}-\d{2}-\d{2}/;
// History words. Hebrew has no \b in JS, so the Hebrew ones are plain substrings.
const REMOVAL_EN = /\b(deleted|removed|retired|gone|no longer|does not exist|doesn't exist|was removed|disabled|archived|dropped|moved|renamed|lives at|formerly)\b/i;
const REMOVAL_HE = /הועבר|הוסר|נמחק|נמחקה|נמחקו|בארכיון|ארכיון|לא קיים|נעלם|הוחלף|בוטל|הפסיק להתקיים/;

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function dayDiff(a, b) { // whole days a - b, both YYYY-MM-DD
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(a) - t(b)) / 86400000);
}

function parseDate(s) {
  const m = DATE_RE.exec(s || '');
  if (!m) return null;
  const [y, mo, d] = m[0].split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? m[0] : null;
}

// Blank out <!-- comments --> and (optionally) inline code, keeping line numbers.
function blankComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
}

// ------------------------------------------------------------------ paths
function resolveBase(token, home) {
  if (token === '~' || token.startsWith('~/') || token.startsWith('~\\')) return path.join(home, token.slice(2));
  if (/^[A-Za-z]:[\\/]/.test(token)) return token;
  if (token.startsWith('/')) {
    const first = token.split('/')[1] || '';
    if (FS_ROOTS.has(first)) return token;
  }
  return null;
}

function cleanToken(tok) {
  tok = tok.trim().replace(/^["']+|["']+$/g, '');
  tok = tok.replace(/#.*$/, '');
  tok = tok.replace(/:\d+(-\d+)?$/, ''); // file.py:123 or :12-30
  tok = tok.replace(/[.,;)]+$/, '');
  if (tok.length > 1) tok = tok.replace(/[\\/]+$/, '');
  return tok;
}

const unresolvableShape = (tok) => /[*?[\]{}<>$]|\.\.\./.test(tok);
const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };

export function classifySpan(span, home) {
  span = span.trim();
  const hasSlash = span.includes('/') || span.includes('\\');
  if (span.includes('://') || (!hasSlash && !span.startsWith('~'))) return 'skip';
  const words = span.split(' ');
  const first = cleanToken(words[0]);
  if (resolveBase(first, home) === null) return hasSlash ? 'unresolvable' : 'skip';
  if (unresolvableShape(first)) return 'unresolvable';
  // Longest word-prefix that exists: handles spaces in names and trailing args (`run.sh on`).
  for (let n = words.length; n > 0; n--) {
    const cand = cleanToken(words.slice(0, n).join(' '));
    const b = resolveBase(cand, home);
    if (b !== null && !unresolvableShape(cand) && exists(b)) return 'alive';
  }
  return unresolvableShape(span) ? 'unresolvable' : 'dead';
}

function scanDeadPaths(file, text, home, out) {
  const seen = new Map();
  let inFence = false;
  const lines = blankComments(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const m of line.matchAll(SPAN_RE)) {
      const kind = classifySpan(m[1], home);
      if (kind === 'unresolvable') { out.unresolvable++; continue; }
      if (kind !== 'dead') continue;
      const disp = m[1].trim();
      if (seen.has(disp)) { seen.get(disp).extra++; continue; }
      const f = { type: 'dead_path', file, line: i + 1, extra: 0,
        detail: '`' + disp + '` does not exist',
        proposed: 'update or remove `' + disp + '` here, or confirm it was removed on purpose. Keep history: add a dated note instead of deleting.' };
      seen.set(disp, f);
      const prose = line.replace(/`[^`\n]+`/g, ' ');
      (REMOVAL_EN.test(prose) || REMOVAL_HE.test(prose) ? out.hints : out.findings).push(f);
    }
  }
  for (const f of seen.values()) if (f.extra) f.detail += ' (+' + f.extra + ' more in this file)';
}

// ------------------------------------------------------------------ index
function scanIndex(indexPath, text, hub, recordNames, out) {
  const linked = new Set();
  const lines = blankComments(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/`[^`\n]+`/g, ' ');
    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(line))) {
      let tgt = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(tgt) || tgt.startsWith('#')) continue;
      tgt = tgt.split('#', 1)[0];
      try { tgt = decodeURIComponent(tgt); } catch (e) { /* keep raw */ }
      if (!tgt) continue;
      linked.add(path.normalize(tgt));
      if (!exists(path.join(hub, tgt))) {
        out.findings.push({ type: 'dangling_index', file: indexPath, line: i + 1,
          detail: 'link target `' + tgt + '` does not exist',
          proposed: 'remove this index line or restore `' + tgt + '`.' });
      }
    }
    WIKI_RE.lastIndex = 0;
    while ((m = WIKI_RE.exec(line))) {
      const n = m[1].trim();
      linked.add(path.normalize(n.endsWith('.md') ? n : n + '.md'));
    }
  }
  for (const name of recordNames) {
    if (!linked.has(name) && !UNINDEXED_OK.has(name)) {
      out.findings.push({ type: 'unindexed', file: path.join(hub, name), line: 1,
        detail: '`' + name + '` has no line in MEMORY.md',
        proposed: 'add an index line for `' + name + '` to MEMORY.md, or delete the file if it is obsolete.' });
    }
  }
}

// ------------------------------------------------------------------ check:
function frontmatter(lines) {
  if (!lines.length || lines[0].trim() !== '---') return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return out;
    out.push([i + 1, lines[i]]);
  }
  return []; // unterminated: ignore
}

function stripQuotes(s) {
  s = s.trim();
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === '"' || s[0] === "'")) s = s.slice(1, -1);
  return s.trim();
}

function collectChecks(fm) {
  const out = [];
  for (let i = 0; i < fm.length; i++) {
    const m = /^(\s*)check:\s*(.*)$/.exec(fm[i][1]);
    if (!m) continue;
    const indent = m[1].length;
    const val = m[2].trim();
    if (val) { out.push([fm[i][0], stripQuotes(val)]); continue; }
    let j = i + 1; // list form
    for (; j < fm.length; j++) {
      const lm = /^(\s*)-\s+(.*)$/.exec(fm[j][1]);
      if (!lm || lm[1].length < indent) break;
      out.push([fm[j][0], stripQuotes(lm[2])]);
    }
    i = j - 1;
  }
  return out;
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function checkPath(p, home) {
  p = stripQuotes(p);
  const base = resolveBase(p, home);
  return base !== null && !unresolvableShape(p) ? base : null;
}

// null = holds. Otherwise { type, msg }. Reads files only; never spawns anything.
export function runCheck(value, home) {
  const parts = value.trim().split(/\s+/);
  const verb = parts[0] || '';
  const rest = value.trim().slice(verb.length).trim();
  if (verb === 'exists' || verb === 'absent') {
    if (!rest) return { type: 'check_invalid', msg: '`' + verb + '` needs a path' };
    const p = checkPath(rest, home);
    if (p === null) return { type: 'check_invalid', msg: 'path must be absolute or start with ~/ : ' + rest };
    const ex = exists(p);
    if (verb === 'exists' && !ex) return { type: 'check_failed', msg: 'expected to exist, missing: ' + rest };
    if (verb === 'absent' && ex) return { type: 'check_failed', msg: 'expected to be absent, still there: ' + rest };
    return null;
  }
  if (verb === 'grep') {
    const toks = splitArgs(rest);
    if (toks.length < 2) return { type: 'check_invalid', msg: 'grep needs <path> <literal-string>' };
    const p = checkPath(toks[0], home);
    if (p === null) return { type: 'check_invalid', msg: 'path must be absolute or start with ~/ : ' + toks[0] };
    const needle = toks.slice(1).join(' ');
    let data;
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(MAX_GREP_BYTES);
        data = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
      } finally { fs.closeSync(fd); }
    } catch (e) { return { type: 'check_failed', msg: 'grep target is not a readable file: ' + toks[0] }; }
    return data.includes(needle) ? null : { type: 'check_failed', msg: 'string ' + JSON.stringify(needle) + ' not found in ' + toks[0] };
  }
  return { type: 'check_invalid', msg: 'unknown verb ' + JSON.stringify(verb) + ' (allowed: exists, absent, grep); not run' };
}

function scanChecks(file, text, home, out) {
  for (const [ln, val] of collectChecks(frontmatter(text.split('\n')))) {
    const r = runCheck(val, home);
    if (!r) continue;
    out.findings.push({ type: r.type, file, line: ln, detail: '`check: ' + val + '` -> ' + r.msg,
      proposed: r.type === 'check_failed'
        ? 'verify this fact again, then update the memory file or retire it.'
        : 'rewrite the `check:` line with exists, absent or grep only.' });
  }
}

// ------------------------------------------------------------------ patterns.md
const RECORD_KEYS = new Set(['status', 'count', 'violations', 'first', 'last', 'review', 'claim', 'action', 'evidence']);

export function parsePatterns(text) {
  const records = [];
  const applied = [];
  let cur = null;
  let section = '';
  let inFence = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (line.startsWith('### ')) {
      cur = { slug: line.slice(4).trim(), line: i + 1, fields: {}, evidence: 0, inEvidence: false };
      records.push(cur);
      continue;
    }
    if (/^#{1,2} /.test(line)) { cur = null; section = line.replace(/^#+\s*/, '').trim(); continue; }
    if (cur) {
      const m = /^- ([a-z_]+):\s*(.*)$/.exec(line);
      if (m) {
        cur.inEvidence = m[1] === 'evidence';
        cur.fields[m[1]] = m[2].trim();
        if (m[1] === 'evidence' && m[2].trim()) cur.evidence++;
        continue;
      }
      if (cur.inEvidence && /^\s+- \S/.test(line)) cur.evidence++;
    } else if (/^applied/i.test(section)) applied.push(line);
  }
  // Prose under a `###` heading is not a record. Only blocks that carry record keys count.
  return { records: records.filter((r) => Object.keys(r.fields).some((k) => RECORD_KEYS.has(k))), applied: applied.join('\n') };
}

function scanPatterns(file, text, today, out) {
  const { records, applied } = parsePatterns(text);
  out.stats.patternRecords = records.length;
  for (const r of records) {
    const f = r.fields;
    const missing = [];
    if (!(f.claim || '').trim()) missing.push('claim');
    if (r.evidence === 0) missing.push('evidence');
    const review = parseDate(f.review);
    if (!('review' in f)) missing.push('review');
    else if (!review) missing.push('review (needs YYYY-MM-DD)');
    if (missing.length) {
      out.findings.push({ type: 'malformed', file, line: r.line, detail: '`' + r.slug + '` missing: ' + missing.join(', '),
        proposed: 'add the missing field(s) or drop the record (see skills/memory-consolidation/references/record-format.md).' });
    }
    if (review && review < today) {
      out.findings.push({ type: 'review_overdue', file, line: r.line,
        detail: '`' + r.slug + '` review ' + review + ' is ' + dayDiff(today, review) + ' day(s) past',
        proposed: 're-confirm it against fresh evidence and bump `review`, or move it to dismissed.' });
      if (/^none yet/i.test((f.action || '').trim())) {
        out.hints.push({ type: 'none_yet_past_review', file, line: r.line,
          detail: '`' + r.slug + '` still has `action: none yet` past its review date' });
      }
    }
    if ((f.status || '').trim() === 'observed' && applied &&
      new RegExp('(?<![\\w-])' + r.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])').test(applied)) {
      out.hints.push({ type: 'possibly_applied', file, line: r.line,
        detail: '`' + r.slug + '` is `status: observed` but is named in the Applied section. If its action is live, set `status: applied` (heuristic).' });
    }
  }
}

// ------------------------------------------------------------------ main
export function listRecordFiles(hub) {
  const names = [];
  for (const e of fs.readdirSync(hub, { withFileTypes: true })) {
    const n = e.name;
    if (!e.isFile() || !n.endsWith('.md') || n.startsWith('.') || n.includes('.bak-')) continue;
    if (SYSTEM_FILES.has(n.toLowerCase())) continue;
    names.push(n);
  }
  return names;
}

function readHead(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(MAX_FILE_BYTES);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
  } finally { fs.closeSync(fd); }
}

export function checkMemory({ hub, home, today = localDate(), budgetMs = 150, startedAt = performance.now(), now = () => performance.now() }) {
  const out = { findings: [], hints: [], unresolvable: 0, stats: { files: 0, partial: false, patternRecords: 0 } };
  const over = () => now() - startedAt > budgetMs;

  // Record files: top-level *.md with frontmatter, minus the system files. Newest first, so a
  // partial scan covers what changed most recently.
  const recordNames = [];
  const withTime = [];
  for (const n of listRecordFiles(hub)) {
    let head = '';
    try {
      const fd = fs.openSync(path.join(hub, n), 'r');
      try { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); head = b.toString('utf8'); } finally { fs.closeSync(fd); }
    } catch (e) { continue; }
    if (!head.startsWith('---')) continue;
    recordNames.push(n);
    let mt = 0; try { mt = fs.statSync(path.join(hub, n)).mtimeMs; } catch (e) { /* keep 0 */ }
    withTime.push([n, mt]);
  }
  withTime.sort((a, b) => b[1] - a[1]);

  const indexPath = path.join(hub, 'MEMORY.md');
  const order = [indexPath, ...withTime.map(([n]) => path.join(hub, n))];
  for (const file of order) {
    if (over()) { out.stats.partial = true; break; }
    let text;
    try { text = readHead(file); } catch (e) { continue; }
    out.stats.files++;
    if (file === indexPath) scanIndex(indexPath, text, hub, recordNames, out);
    scanDeadPaths(file, text, home, out);
    if (file !== indexPath) scanChecks(file, text, home, out);
  }

  const patterns = path.join(hub, 'patterns.md');
  if (exists(patterns)) {
    if (over()) out.stats.partial = true;
    else { try { scanPatterns(patterns, readHead(patterns), today, out); } catch (e) { /* unreadable */ } }
  }

  const rank = new Map(TYPES.map((t, i) => [t, i]));
  out.findings.sort((a, b) => rank.get(a.type) - rank.get(b.type) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line);
  out.stats.unresolvable = out.unresolvable;
  return { findings: out.findings, hints: out.hints, stats: out.stats };
}

// ------------------------------------------------------------------ report
export function renderReport({ today, findings, hints, stats }) {
  const L = ['# Memory check ' + today, '',
    'Nothing was changed. Ask Claude to fix these, or edit the files yourself.',
    'When a fact is stale, prefer a dated note ("moved to X, checked ' + today + '") over deleting it: the old fact still explains past decisions.',
    ''];
  if (stats.partial) L.push('**Partial:** the scan hit its time budget and stopped early. Newest files were checked first.', '');
  const counts = {};
  for (const f of findings) counts[f.type] = (counts[f.type] || 0) + 1;
  L.push('Found ' + findings.length + ' item(s) in ' + stats.files + ' file(s)' +
    (stats.unresolvable ? '; ' + stats.unresolvable + ' path-like text(s) were not checked because they are not unambiguous paths' : '') + '.', '');
  for (const t of TYPES) {
    const items = findings.filter((f) => f.type === t);
    if (!items.length) continue;
    L.push('## ' + TITLES[t] + ' (' + items.length + ')', '');
    for (const f of items) {
      L.push('- `' + f.file + ':' + f.line + '` ' + f.detail);
      L.push('  Proposed: ' + f.proposed);
    }
    L.push('');
  }
  if (hints.length) {
    L.push('## Not counted', '',
      'History notes and heuristics. Listed so you can judge them; they do not raise the session notice.', '');
    for (const h of hints) L.push('- `' + h.file + ':' + h.line + '` ' + h.detail);
    L.push('');
  }
  return L.join('\n');
}
