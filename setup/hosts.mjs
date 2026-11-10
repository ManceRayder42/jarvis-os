// setup/hosts.mjs -- host adapters: run Jarvis OS from OpenAI Codex CLI and Cursor.
//
// The plugin stays single-source. The hub is one folder, skills live in skills/,
// MCP servers come from setup/tools-catalog.json. This file only WIRES a host to
// them, with files the host documents:
//
//   codex   ~/.codex/AGENTS.md          managed block: where the hub is, read it at session start
//           ~/.codex/hooks.json         SessionStart hook -> hooks/session-start.mjs --host codex
//           ~/.codex/config.toml        managed block of [mcp_servers.<id>] tables
//           ~/.agents/skills/<id>       one symlink per enabled skill
//   cursor  ~/.cursor/hooks.json        sessionStart hook -> hooks/session-start.mjs --host cursor
//           ~/.cursor/mcp.json          mcpServers.<id> entries
//           ~/.cursor/skills/<id>       one copy per enabled skill (older Cursor builds did not follow symlinks; copies are always safe)
//           <project>/.cursor/rules/jarvis-hub.mdc   only with --project (~/.cursor/rules is only partly supported by Cursor, so it is not written)
//
// Rules every write obeys:
//   - idempotent: running twice changes nothing the second time
//   - never overwrites user content: our text lives between marker comments (or in a
//     file that is wholly ours), a same-named entry the user made is left alone and reported
//   - backs up an existing file before the first change to it
//   - undoable: uninstallHost() removes exactly what installHost() added
//   - stateless: no manifest. Ownership is read from the markers, the hook command and the
//     skill link/marker, so there is nothing to get out of sync
//   - a file that does not parse is reported and left untouched
//
// Docs each mechanism rests on are listed in docs/details.md ("Codex and Cursor").

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PLUGIN_ROOT = path.resolve(HERE, '..');
export const HOSTS = ['codex', 'cursor'];

const MD_OPEN = '<!-- >>> jarvis-os (managed by setup/agent.mjs install-host; remove with uninstall-host) >>> -->';
const MD_CLOSE = '<!-- <<< jarvis-os <<< -->';
const TOML_OPEN = '# >>> jarvis-os (managed by setup/agent.mjs install-host; remove with uninstall-host) >>>';
const TOML_CLOSE = '# <<< jarvis-os <<<';
const SKILL_MARKER = '.jarvis-os-managed';
const RULE_MARKER = '<!-- jarvis-os managed rule: remove with uninstall-host -->';

// ---------------------------------------------------------------- file helpers

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function lstat(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.jarvis-os-tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function backupName(file, now) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  let n = file + '.jarvis-os-backup-' + stamp;
  for (let i = 1; lstat(n); i++) n = file + '.jarvis-os-backup-' + stamp + '-' + i;
  return n;
}

// Write `next` to `file` unless it already holds exactly that. Backs up an existing
// file first. A `null` next removes a file that held nothing but our content. Returns the action.
function commitFile(ctx, kind, file, next, detail) {
  const cur = readText(file);
  if (next === null) {
    if (cur === null) return act(ctx, kind, file, 'unchanged', detail);
    // Only ever called when nothing but our own content was left in the file, so no backup.
    if (!ctx.dryRun) fs.rmSync(file);
    return act(ctx, kind, file, 'removed', detail);
  }
  if (cur === next) return act(ctx, kind, file, 'unchanged', detail);
  if (!ctx.dryRun) {
    if (cur !== null) fs.copyFileSync(file, backupName(file, ctx.now));
    writeAtomic(file, next);
  }
  return act(ctx, kind, file, cur === null ? 'created' : 'updated', detail);
}

function act(ctx, kind, file, status, detail) {
  const a = { kind, path: file, status, detail: detail || '' };
  ctx.actions.push(a);
  return a;
}

function problem(ctx, kind, file, detail) {
  ctx.ok = false;
  return act(ctx, kind, file, 'error', detail);
}

// ---------------------------------------------------------------- managed blocks

function findBlock(text, open, close) {
  const a = text.indexOf(open);
  if (a < 0) return { found: false };
  const b = text.indexOf(close, a + open.length);
  if (b < 0) return { found: true, broken: true };
  return { found: true, start: a, end: b + close.length };
}

// Returns the new text, or null when the markers are damaged (caller reports, writes nothing).
function upsertBlock(text, block, open, close) {
  const f = findBlock(text, open, close);
  if (f.broken) return null;
  const body = open + '\n' + block.replace(/\n+$/, '') + '\n' + close;
  if (f.found) return text.slice(0, f.start) + body + text.slice(f.end);
  if (!text) return body + '\n';
  return text.replace(/\n*$/, '\n') + '\n' + body + '\n';
}

function removeBlock(text, open, close) {
  const f = findBlock(text, open, close);
  if (f.broken) return null;
  if (!f.found) return text;
  let before = text.slice(0, f.start);
  let after = text.slice(f.end).replace(/^\n/, '');
  // Undo the blank separator upsertBlock added.
  if (before.endsWith('\n\n')) before = before.slice(0, -1);
  return before + after;
}

// ---------------------------------------------------------------- instruction text

function instructionText(host, root) {
  const skill = host === 'codex' ? '`$done`' : '`/done`';
  return [
    '## Jarvis memory (jarvis-os)',
    '',
    'A persistent memory hub (a folder of markdown notes) carries context between sessions and projects.',
    '',
    '- Find the hub: the `JARVIS_HUB` environment variable if set, otherwise the path written in `~/.jarvis-hub-path`.',
    '- At the start of a session, unless a "# Jarvis memory" section was already injected into your context, read `<hub>/MEMORY.md` and, if it exists, `<hub>/working-rules.md`. Read other hub files only when a task needs them.',
    '- If there is no hub or no `MEMORY.md`, the memory is not set up. Say so once and offer to set it up: `node "' + path.join(root, 'setup', 'agent.mjs') + '" plan`.',
    '- The jarvis-os skills are installed for you. Their instructions say `${CLAUDE_PLUGIN_ROOT}`; on this host that means `' + root + '`.',
    '- When the user says "done" or ends a work session, use the ' + skill + ' skill so the session is written into the hub.',
  ].join('\n');
}

// ---------------------------------------------------------------- skills

// Skills Claude Code loads: everything under <root>/skills that has a SKILL.md
// (optional skills appear there as symlinks once enabled).
export function listSkills(root) {
  const dir = path.join(root, 'skills');
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const id of entries.sort()) {
    const p = path.join(dir, id);
    try {
      if (fs.statSync(p).isDirectory() && fs.statSync(path.join(p, 'SKILL.md')).isFile()) out.push(id);
    } catch { /* dangling link or no SKILL.md */ }
  }
  return out;
}

function catalogSkillIds(root) {
  try { return new Set(JSON.parse(fs.readFileSync(path.join(root, 'setup', 'skills-catalog.json'), 'utf8')).skills.map((s) => s.id)); }
  catch { return new Set(); }
}

// Two vendored skills open with an HTML licence comment before the `---` frontmatter.
// Claude Code reads that fine; a strict frontmatter parser may not, so the host copy
// moves the comment under the frontmatter. Returns the text to install, or null if as-is.
function normalizedSkillMd(text) {
  const m = text.match(/^(<!--[\s\S]*?-->)\s*\n(---\n[\s\S]*?\n---\n?)/);
  if (!m) return null;
  return m[2].replace(/\n?$/, '\n') + '\n' + m[1] + '\n' + text.slice(m[0].length);
}

function walk(dir, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
    if (name === 'node_modules' || name === '.DS_Store' || name === SKILL_MARKER) continue;
    const r = path.join(rel, name);
    const st = fs.statSync(path.join(dir, r));
    if (st.isDirectory()) out.push(...walk(dir, r)); else out.push(r);
  }
  return out;
}

// Content hash of what a copy of `src` would hold (after normalizing SKILL.md).
function treeHash(src) {
  const h = crypto.createHash('sha256');
  for (const rel of walk(src)) {
    let data = fs.readFileSync(path.join(src, rel));
    if (rel === 'SKILL.md') { const n = normalizedSkillMd(data.toString('utf8')); if (n !== null) data = Buffer.from(n); }
    h.update(rel + '\0').update(data).update('\0');
  }
  return h.digest('hex');
}

function copySkill(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of walk(src)) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    let data = fs.readFileSync(path.join(src, rel));
    if (rel === 'SKILL.md') { const n = normalizedSkillMd(data.toString('utf8')); if (n !== null) data = Buffer.from(n); }
    fs.writeFileSync(to, data);
    fs.chmodSync(to, fs.statSync(path.join(src, rel)).mode & 0o777);
  }
}

function skillState(dest, id, srcLink, ids) {
  const st = lstat(dest);
  if (!st) return { kind: 'none' };
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = path.resolve(path.dirname(dest), fs.readlinkSync(dest)); } catch { /* ignore */ }
    // Ours: it points at <some plugin root>/skills/<id>. Matching on the id (a catalog id)
    // keeps links from an earlier checkout location recognisable.
    const ours = target === srcLink || (ids.has(id) && target.endsWith(path.sep + path.join('skills', id)));
    return { kind: ours ? 'link' : 'foreign', target };
  }
  if (st.isDirectory()) {
    const marker = readText(path.join(dest, SKILL_MARKER));
    if (marker !== null) { let m = {}; try { m = JSON.parse(marker); } catch { /* old/damaged marker: still ours */ } return { kind: 'copy', hash: m.hash }; }
  }
  return { kind: 'foreign' };
}

function removeSkillEntry(dest, state) {
  if (state.kind === 'link') fs.unlinkSync(dest);
  else if (state.kind === 'copy') fs.rmSync(dest, { recursive: true, force: true });
}

// mode: 'link' (symlink to <root>/skills/<id>) or 'copy'. A skill whose SKILL.md needs
// normalizing is always copied.
function syncSkills(ctx, destDir, mode) {
  const root = ctx.root;
  const ids = catalogSkillIds(root);
  const wanted = listSkills(root);
  for (const id of wanted) {
    const src = path.join(root, 'skills', id);
    const dest = path.join(destDir, id);
    const needsCopy = mode === 'copy' || normalizedSkillMd(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8')) !== null;
    const state = skillState(dest, id, src, ids);
    if (state.kind === 'foreign') { act(ctx, 'skill', dest, 'skipped', 'exists and is not managed by jarvis-os; left alone'); continue; }
    if (!needsCopy) {
      if (state.kind === 'link' && state.target === src) { act(ctx, 'skill', dest, 'unchanged'); continue; }
      if (!ctx.dryRun) {
        if (state.kind !== 'none') removeSkillEntry(dest, state);
        fs.mkdirSync(destDir, { recursive: true });
        try { fs.symlinkSync(src, dest, 'dir'); }
        catch (e) { if (e.code === 'EPERM' || e.code === 'ENOSYS') { copySkill(src, dest); fs.writeFileSync(path.join(dest, SKILL_MARKER), JSON.stringify({ source: src, hash: treeHash(src) })); } else throw e; }
      }
      act(ctx, 'skill', dest, state.kind === 'none' ? 'created' : 'updated', 'symlink');
    } else {
      const hash = treeHash(src);
      if (state.kind === 'copy' && state.hash === hash) { act(ctx, 'skill', dest, 'unchanged'); continue; }
      if (!ctx.dryRun) {
        if (state.kind !== 'none') removeSkillEntry(dest, state);
        copySkill(src, dest);
        fs.writeFileSync(path.join(dest, SKILL_MARKER), JSON.stringify({ source: src, hash }));
      }
      act(ctx, 'skill', dest, state.kind === 'none' ? 'created' : 'updated', 'copy');
    }
  }
  // Prune ours that are no longer enabled.
  let existing = [];
  try { existing = fs.readdirSync(destDir); } catch { /* no dir yet */ }
  for (const id of existing) {
    if (wanted.includes(id)) continue;
    const dest = path.join(destDir, id);
    const state = skillState(dest, id, path.join(root, 'skills', id), ids);
    if (state.kind === 'link' || state.kind === 'copy') {
      if (!ctx.dryRun) removeSkillEntry(dest, state);
      act(ctx, 'skill', dest, 'removed', 'no longer enabled');
    }
  }
}

function removeAllSkills(ctx, destDir) {
  const ids = catalogSkillIds(ctx.root);
  let existing = [];
  try { existing = fs.readdirSync(destDir); } catch { return; }
  for (const id of existing) {
    const dest = path.join(destDir, id);
    const state = skillState(dest, id, path.join(ctx.root, 'skills', id), ids);
    if (state.kind === 'link' || state.kind === 'copy') {
      if (!ctx.dryRun) removeSkillEntry(dest, state);
      act(ctx, 'skill', dest, 'removed');
    }
  }
  // Leave an empty skills dir if we created nothing else there? Remove only if empty.
  try { if (!ctx.dryRun && fs.readdirSync(destDir).length === 0) fs.rmdirSync(destDir); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- MCP selection

function loadCatalog(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'setup', 'tools-catalog.json'), 'utf8')).tools.filter((t) => t.kind === 'mcp');
}

function tokenEnv(id) { return 'JARVIS_MCP_' + id.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_TOKEN'; }

// mcp: 'default' (recommended, keyless) | 'none' | 'all' | ['id', ...]
function selectMcp(ctx) {
  const all = ctx.catalog || loadCatalog(ctx.root);
  const keyed = (t) => Boolean(t.secret || (t.mcp && t.mcp.header_secret));
  const m = ctx.mcp;
  if (m === 'none') return [];
  if (m === 'all') return all;
  if (Array.isArray(m)) {
    const picked = [];
    for (const id of m) {
      const t = all.find((x) => x.id === id);
      if (!t) { problem(ctx, 'mcp', id, 'not an MCP server in setup/tools-catalog.json'); continue; }
      picked.push(t);
    }
    return picked;
  }
  return all.filter((t) => t.default && !keyed(t));
}

// ---------------------------------------------------------------- Codex

function codexHome(ctx) { return ctx.codexHome || path.join(ctx.home, '.codex'); }

function tomlStr(s) { return JSON.stringify(String(s)); }

// npx prompts before installing a package; an MCP server cannot answer, so add -y.
function stdioArgs(command) {
  const args = command.slice(1);
  if (command[0] === 'npx' && !args.some((a) => a === '-y' || a === '--yes')) args.unshift('-y');
  return args;
}

function codexMcpBlock(tools, skipIds) {
  const lines = [];
  const used = [];
  for (const t of tools) {
    if (skipIds.has(t.id)) continue;
    const m = t.mcp || {};
    if (m.transport === 'http') {
      lines.push('[mcp_servers.' + t.id + ']', 'url = ' + tomlStr(m.url));
      if (m.header_secret) lines.push('bearer_token_env_var = ' + tomlStr(tokenEnv(t.id)));
    } else if (m.transport === 'stdio' && Array.isArray(m.command) && m.command.length) {
      lines.push('[mcp_servers.' + t.id + ']', 'command = ' + tomlStr(m.command[0]));
      const args = stdioArgs(m.command);
      if (args.length) lines.push('args = [' + args.map(tomlStr).join(', ') + ']');
      lines.push('startup_timeout_sec = 60');
    } else continue;
    lines.push('');
    used.push(t);
  }
  return { text: lines.join('\n').replace(/\n+$/, ''), used };
}

// Server ids the user already defined, outside our block. A second table with the
// same name would make the whole config.toml invalid, so those are left alone.
function userDefinedMcp(tomlText) {
  const f = findBlock(tomlText, TOML_OPEN, TOML_CLOSE);
  const outside = f.found && !f.broken ? tomlText.slice(0, f.start) + tomlText.slice(f.end) : tomlText;
  const ids = new Set();
  const re = /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(?:\]|\.)/gm;
  let m;
  while ((m = re.exec(outside))) ids.add(m[1] || m[2] || m[3]);
  return ids;
}

function codexInstructionFile(ctx) {
  // Codex reads AGENTS.override.md instead of AGENTS.md when the override exists and is not empty.
  const dir = codexHome(ctx);
  const override = path.join(dir, 'AGENTS.override.md');
  // An empty override is skipped by Codex, which then reads AGENTS.md.
  const t = readText(override);
  const useOverride = Boolean(lstat(override)) && t !== null && t.trim() !== '';
  return { target: useOverride ? override : path.join(dir, 'AGENTS.md'), both: [override, path.join(dir, 'AGENTS.md')] };
}

function codexHookCommand(ctx) {
  return 'node ' + JSON.stringify(path.join(ctx.root, 'hooks', 'session-start.mjs')) + ' --host codex';
}

const CODEX_HOOK_RE = /session-start\.mjs"?\s+--host codex\b/;
const CURSOR_HOOK_RE = /session-start\.mjs"?\s+--host cursor\b/;

function parseJson(ctx, kind, file) {
  const text = readText(file);
  if (text === null || text.trim() === '') return { text, data: {} };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('top level is not an object');
    return { text, data };
  } catch (e) {
    problem(ctx, kind, file, 'not valid JSON (' + e.message + '); left untouched. Fix or remove the file, then run again.');
    return null;
  }
}

const jsonOut = (data) => JSON.stringify(data, null, 2) + '\n';

function installCodex(ctx) {
  const dir = codexHome(ctx);

  if (ctx.instructions) {
    const { target, both } = codexInstructionFile(ctx);
    for (const f of both) {
      if (f === target) continue;
      const t = readText(f);
      if (t !== null && findBlock(t, MD_OPEN, MD_CLOSE).found) {
        const n = removeBlock(t, MD_OPEN, MD_CLOSE);
        if (n !== null) commitFile(ctx, 'instructions', f, n.trim() === '' ? null : n, 'moved to ' + path.basename(target));
      }
    }
    const cur = readText(target) || '';
    const next = upsertBlock(cur, instructionText('codex', ctx.root), MD_OPEN, MD_CLOSE);
    if (next === null) problem(ctx, 'instructions', target, 'jarvis-os markers are damaged (opening marker without closing one); left untouched');
    else commitFile(ctx, 'instructions', target, next, path.basename(target) === 'AGENTS.override.md' ? 'written to AGENTS.override.md because Codex reads it instead of AGENTS.md' : '');
  }

  if (ctx.hook) {
    const file = path.join(dir, 'hooks.json');
    const j = parseJson(ctx, 'hook', file);
    if (j) {
      const data = j.data;
      data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
      const entry = { matcher: 'startup|resume|clear', hooks: [{ type: 'command', command: codexHookCommand(ctx), statusMessage: 'Loading Jarvis memory...', timeout: 10, additionalContextLimit: 6000 }] };
      data.hooks.SessionStart = upsertEntry(Array.isArray(data.hooks.SessionStart) ? data.hooks.SessionStart : [], (g) => groupHas(g, CODEX_HOOK_RE), entry);
      commitFile(ctx, 'hook', file, jsonOut(data), 'SessionStart; Codex asks you to trust it once: run /hooks inside codex');
    }
  }

  if (ctx.mcpSel.length) {
    const file = path.join(dir, 'config.toml');
    const cur = readText(file) || '';
    const userIds = userDefinedMcp(cur);
    // Additive: servers an earlier run put in our block stay, the new selection joins them.
    const known = ctx.catalog || loadCatalog(ctx.root);
    const f0 = findBlock(cur, TOML_OPEN, TOML_CLOSE);
    const prior = f0.found && !f0.broken ? [...cur.slice(f0.start, f0.end).matchAll(/^\[mcp_servers\.([^\]]+)\]/gm)].map((m) => m[1]) : [];
    const merged = [];
    for (const t of [...known.filter((k) => prior.includes(k.id)), ...ctx.mcpSel]) if (!merged.some((x) => x.id === t.id)) merged.push(t);
    const { text, used } = codexMcpBlock(merged, userIds);
    for (const t of ctx.mcpSel) if (userIds.has(t.id)) act(ctx, 'mcp', file, 'skipped', t.id + ': you already defined [mcp_servers.' + t.id + ']; left alone');
    if (used.length) {
      const n = upsertBlock(cur, text, TOML_OPEN, TOML_CLOSE);
      if (n === null) problem(ctx, 'mcp', file, 'jarvis-os markers are damaged; left untouched');
      else {
        const keyed = used.filter((t) => t.mcp && t.mcp.header_secret).map((t) => t.id + ' needs env var ' + tokenEnv(t.id));
        commitFile(ctx, 'mcp', file, n, used.map((t) => t.id).join(', ') + (keyed.length ? ' (' + keyed.join('; ') + ')' : ''));
      }
    }
  }

  if (ctx.skills) syncSkills(ctx, path.join(ctx.home, '.agents', 'skills'), ctx.skillMode || 'link');
}

// Replace our entry where it already is (so the user's ordering is kept), else append.
function upsertEntry(list, isOurs, entry) {
  const out = [];
  let placed = false;
  for (const x of list) {
    if (!isOurs(x)) { out.push(x); continue; }
    if (!placed) { out.push(entry); placed = true; }
  }
  if (!placed) out.push(entry);
  return out;
}

function groupHas(group, re) {
  const hs = group && Array.isArray(group.hooks) ? group.hooks : [];
  return hs.some((h) => h && typeof h.command === 'string' && re.test(h.command));
}

function uninstallCodex(ctx) {
  const dir = codexHome(ctx);
  for (const f of [path.join(dir, 'AGENTS.override.md'), path.join(dir, 'AGENTS.md')]) {
    const t = readText(f);
    if (t === null || !findBlock(t, MD_OPEN, MD_CLOSE).found) continue;
    const n = removeBlock(t, MD_OPEN, MD_CLOSE);
    if (n === null) problem(ctx, 'instructions', f, 'jarvis-os markers are damaged; left untouched');
    else commitFile(ctx, 'instructions', f, n.trim() === '' ? null : n);
  }
  const hooks = path.join(dir, 'hooks.json');
  const j = readText(hooks) !== null ? parseJson(ctx, 'hook', hooks) : null;
  if (j && j.data.hooks && Array.isArray(j.data.hooks.SessionStart) && j.data.hooks.SessionStart.some((g) => groupHas(g, CODEX_HOOK_RE))) {
    const data = j.data;
    data.hooks.SessionStart = data.hooks.SessionStart.filter((g) => !groupHas(g, CODEX_HOOK_RE));
    if (!data.hooks.SessionStart.length) delete data.hooks.SessionStart;
    if (!Object.keys(data.hooks).length) delete data.hooks;
    commitFile(ctx, 'hook', hooks, Object.keys(data).length ? jsonOut(data) : null);
  }
  const toml = path.join(dir, 'config.toml');
  const t = readText(toml);
  if (t !== null && findBlock(t, TOML_OPEN, TOML_CLOSE).found) {
    const n = removeBlock(t, TOML_OPEN, TOML_CLOSE);
    if (n === null) problem(ctx, 'mcp', toml, 'jarvis-os markers are damaged; left untouched');
    else commitFile(ctx, 'mcp', toml, n.trim() === '' ? null : n);
  }
  removeAllSkills(ctx, path.join(ctx.home, '.agents', 'skills'));
}

// ---------------------------------------------------------------- Cursor

function cursorHome(ctx) { return path.join(ctx.home, '.cursor'); }

function cursorMcpEntry(t) {
  const m = t.mcp || {};
  if (m.transport === 'http') {
    const e = { url: m.url };
    if (m.header_secret) e.headers = { Authorization: 'Bearer ${env:' + tokenEnv(t.id) + '}' };
    return e;
  }
  if (m.transport === 'stdio' && Array.isArray(m.command) && m.command.length) {
    const e = { type: 'stdio', command: m.command[0] };
    const args = stdioArgs(m.command);
    if (args.length) e.args = args;
    return e;
  }
  return null;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function cursorRulePath(project) { return path.join(project, '.cursor', 'rules', 'jarvis-hub.mdc'); }

function cursorRuleText(root) {
  return '---\ndescription: Jarvis memory hub - read at the start of a session\nalwaysApply: true\n---\n' + RULE_MARKER + '\n\n' + instructionText('cursor', root) + '\n';
}

export function userRuleText(root = DEFAULT_PLUGIN_ROOT) {
  return instructionText('cursor', root) + '\n';
}

function installCursor(ctx) {
  const dir = cursorHome(ctx);

  if (ctx.hook) {
    const file = path.join(dir, 'hooks.json');
    const j = parseJson(ctx, 'hook', file);
    if (j) {
      const data = j.data;
      if (data.version === undefined) data.version = 1;
      data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
      const entry = { command: 'node ' + JSON.stringify(path.join(ctx.root, 'hooks', 'session-start.mjs')) + ' --host cursor', timeout: 10 };
      data.hooks.sessionStart = upsertEntry(Array.isArray(data.hooks.sessionStart) ? data.hooks.sessionStart : [], (h) => h && typeof h.command === 'string' && CURSOR_HOOK_RE.test(h.command), entry);
      commitFile(ctx, 'hook', file, jsonOut(data), 'sessionStart; Cursor runs it fire-and-forget, so also add the User Rule (install-host cursor --print-user-rule)');
    }
  }

  if (ctx.mcpSel.length) {
    const file = path.join(dir, 'mcp.json');
    const j = parseJson(ctx, 'mcp', file);
    if (j) {
      const data = j.data;
      const servers = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {};
      const done = [];
      for (const t of ctx.mcpSel) {
        const want = cursorMcpEntry(t);
        if (!want) { problem(ctx, 'mcp', file, t.id + ': catalog entry has no usable connector'); continue; }
        if (servers[t.id] !== undefined && !same(servers[t.id], want)) { act(ctx, 'mcp', file, 'skipped', t.id + ': you already have a different "' + t.id + '" entry; left alone'); continue; }
        servers[t.id] = want;
        done.push(t.id + (t.mcp && t.mcp.header_secret ? ' (needs env var ' + tokenEnv(t.id) + ')' : ''));
      }
      if (done.length) { data.mcpServers = servers; commitFile(ctx, 'mcp', file, jsonOut(data), done.join(', ')); }
    }
  }

  if (ctx.skills) syncSkills(ctx, path.join(dir, 'skills'), ctx.skillMode || 'copy');

  if (ctx.project) {
    const file = cursorRulePath(ctx.project);
    const cur = readText(file);
    if (cur !== null && !cur.includes(RULE_MARKER)) act(ctx, 'rule', file, 'skipped', 'exists and is not managed by jarvis-os; left alone');
    else commitFile(ctx, 'rule', file, cursorRuleText(ctx.root), 'project rule, alwaysApply');
  }
}

function uninstallCursor(ctx) {
  const dir = cursorHome(ctx);
  const hooks = path.join(dir, 'hooks.json');
  const j = readText(hooks) !== null ? parseJson(ctx, 'hook', hooks) : null;
  if (j && j.data.hooks && Array.isArray(j.data.hooks.sessionStart) && j.data.hooks.sessionStart.some((h) => h && typeof h.command === 'string' && CURSOR_HOOK_RE.test(h.command))) {
    const data = j.data;
    data.hooks.sessionStart = data.hooks.sessionStart.filter((h) => !(h && typeof h.command === 'string' && CURSOR_HOOK_RE.test(h.command)));
    if (!data.hooks.sessionStart.length) delete data.hooks.sessionStart;
    if (!Object.keys(data.hooks).length) delete data.hooks;
    const onlyVersion = Object.keys(data).every((k) => k === 'version');
    commitFile(ctx, 'hook', hooks, onlyVersion ? null : jsonOut(data));
  }

  const mcp = path.join(dir, 'mcp.json');
  const m = readText(mcp) !== null ? parseJson(ctx, 'mcp', mcp) : null;
  if (m && m.data.mcpServers && typeof m.data.mcpServers === 'object') {
    const data = m.data;
    let removed = 0;
    for (const t of ctx.catalog || loadCatalog(ctx.root)) {
      const want = cursorMcpEntry(t);
      if (want && data.mcpServers[t.id] !== undefined && same(data.mcpServers[t.id], want)) { delete data.mcpServers[t.id]; removed++; }
    }
    if (removed) {
      if (!Object.keys(data.mcpServers).length) delete data.mcpServers;
      commitFile(ctx, 'mcp', mcp, Object.keys(data).length ? jsonOut(data) : null);
    }
  }

  removeAllSkills(ctx, path.join(dir, 'skills'));

  if (ctx.project) {
    const file = cursorRulePath(ctx.project);
    const cur = readText(file);
    if (cur !== null && cur.includes(RULE_MARKER)) commitFile(ctx, 'rule', file, null);
  }
}

// ---------------------------------------------------------------- status

function statusOf(ctx, host) {
  const rows = [];
  const add = (item, ok, detail) => rows.push({ item, ok, detail: detail || '' });
  if (host === 'codex') {
    const dir = codexHome(ctx);
    const inst = [path.join(dir, 'AGENTS.override.md'), path.join(dir, 'AGENTS.md')].find((f) => { const t = readText(f); return t !== null && findBlock(t, MD_OPEN, MD_CLOSE).found; });
    add('instructions', Boolean(inst), inst || 'no jarvis-os block in ' + path.join(dir, 'AGENTS.md'));
    const j = readText(path.join(dir, 'hooks.json'));
    let hook = false; try { hook = Boolean(j && JSON.parse(j).hooks.SessionStart.some((g) => groupHas(g, CODEX_HOOK_RE))); } catch { /* none */ }
    add('hook', hook, hook ? 'registered; trust it once with /hooks inside codex' : 'not registered');
    const t = readText(path.join(dir, 'config.toml')) || '';
    const f = findBlock(t, TOML_OPEN, TOML_CLOSE);
    const ids = f.found && !f.broken ? [...t.slice(f.start, f.end).matchAll(/^\[mcp_servers\.([^\]]+)\]/gm)].map((m) => m[1]) : [];
    add('mcp', ids.length > 0, ids.join(', ') || 'none');
  } else {
    const dir = cursorHome(ctx);
    const j = readText(path.join(dir, 'hooks.json'));
    let hook = false; try { hook = Boolean(j && JSON.parse(j).hooks.sessionStart.some((h) => CURSOR_HOOK_RE.test(h.command))); } catch { /* none */ }
    add('hook', hook, hook ? 'registered (fire-and-forget in Cursor)' : 'not registered');
    let ids = [];
    try { const s = JSON.parse(readText(path.join(dir, 'mcp.json'))).mcpServers; ids = (ctx.catalog || loadCatalog(ctx.root)).filter((t) => s[t.id] !== undefined && same(s[t.id], cursorMcpEntry(t))).map((t) => t.id); } catch { /* none */ }
    add('mcp', ids.length > 0, ids.join(', ') || 'none');
    if (ctx.project) add('project rule', (readText(cursorRulePath(ctx.project)) || '').includes(RULE_MARKER), cursorRulePath(ctx.project));
  }
  const skillsDir = host === 'codex' ? path.join(ctx.home, '.agents', 'skills') : path.join(cursorHome(ctx), 'skills');
  const ids = catalogSkillIds(ctx.root);
  let have = 0;
  try { for (const id of fs.readdirSync(skillsDir)) { const k = skillState(path.join(skillsDir, id), id, path.join(ctx.root, 'skills', id), ids).kind; if (k === 'link' || k === 'copy') have++; } } catch { /* none */ }
  add('skills', have > 0, have + ' of ' + listSkills(ctx.root).length + ' enabled skills in ' + skillsDir);
  return rows;
}

// ---------------------------------------------------------------- public API

function makeCtx(opts = {}) {
  return {
    home: opts.home || os.homedir(),
    codexHome: opts.codexHome || (opts.home ? null : process.env.CODEX_HOME) || null,
    root: path.resolve(opts.pluginRoot || DEFAULT_PLUGIN_ROOT),
    mcp: opts.mcp === undefined ? 'default' : opts.mcp,
    catalog: opts.catalog || null,
    skills: opts.skills !== false,
    hook: opts.hook !== false,
    instructions: opts.instructions !== false,
    skillMode: opts.skillMode || null,
    project: opts.project ? path.resolve(opts.project) : null,
    dryRun: Boolean(opts.dryRun),
    now: opts.now || new Date(),
    actions: [],
    ok: true,
  };
}

/**
 * @param {'codex'|'cursor'} host
 * @param {object} opts { home, codexHome, pluginRoot, mcp, skills, hook, instructions, skillMode, project, dryRun }
 * @returns {{ok:boolean, host:string, actions:{kind:string,path:string,status:string,detail:string}[]}}
 */
export function installHost(host, opts) {
  if (!HOSTS.includes(host)) throw new Error('unknown host: ' + host + ' (expected ' + HOSTS.join(' or ') + ')');
  const ctx = makeCtx(opts);
  ctx.mcpSel = selectMcp(ctx);
  (host === 'codex' ? installCodex : installCursor)(ctx);
  return { ok: ctx.ok, host, actions: ctx.actions };
}

export function uninstallHost(host, opts) {
  if (!HOSTS.includes(host)) throw new Error('unknown host: ' + host + ' (expected ' + HOSTS.join(' or ') + ')');
  const ctx = makeCtx(opts);
  (host === 'codex' ? uninstallCodex : uninstallCursor)(ctx);
  return { ok: ctx.ok, host, actions: ctx.actions };
}

export function hostStatus(host, opts) {
  if (!HOSTS.includes(host)) throw new Error('unknown host: ' + host + ' (expected ' + HOSTS.join(' or ') + ')');
  const ctx = makeCtx(opts);
  return { host, rows: statusOf(ctx, host) };
}

// What each host cannot do, said plainly. Printed after install so nobody assumes parity.
export const GAPS = {
  codex: [
    'Memory at session start: the hook needs a one-time trust. Run codex, type /hooks and trust "Loading Jarvis memory...". Until then the AGENTS.md block makes Codex read the hub itself.',
    'Codex detects new skills automatically; restart Codex only if they do not appear. Optional skills you enable later need install-host to be run again.',
  ],
  cursor: [
    'Cursor has no global rules file that install-host can write: ~/.cursor/rules is only partly supported (needs --- frontmatter, loads only for workspaces under your home folder), so it is not written. Add the User Rule once by hand (Customize > Rules; older builds: Cursor Settings > Rules > User Rules): node setup/agent.mjs install-host cursor --print-user-rule',
    'Cursor CLI: the documented rule sources are .cursor/rules in the project (install-host cursor --project <dir>) or an AGENTS.md / CLAUDE.md at the project root. Whether the User Rule applies in the CLI is not documented.',
    'The sessionStart hook is fire-and-forget. The Agents Window drops its additional_context (a known Cursor issue, forum thread 174143, 2026-10-09); the editor agent panel works. One user reports CLI 2026.11.05 not loading ~/.cursor/hooks.json (forum thread 177989), unconfirmed. Treat the User Rule (or --project rule) as the reliable path.',
    'Skills are copied, not linked (older Cursor builds did not follow symlinked skills; fixed in 2.5, copies stay safe). Run install-host again after a plugin update or after enabling a skill. If you turn on "Sync Skills for Cloud Agents", Cursor moves ~/.cursor/skills contents to synced storage and a later install-host run may conflict.',
    'Cursor CLI asks for approval before using MCP servers: run `agent mcp enable <id>` or start with `--approve-mcps`.',
  ],
};
