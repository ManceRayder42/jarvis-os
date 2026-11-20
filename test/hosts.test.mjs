// Host adapters (setup/hosts.mjs) and the hook's --host modes, run against a fake HOME.
// Nothing here touches the real home directory: every path below is under a temp dir.
//   node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installHost, uninstallHost, hostStatus, listSkills } from '../setup/hosts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'shufi-hosts-')); }
function read(p) { return fs.readFileSync(p, 'utf8'); }
function exists(p) { try { fs.lstatSync(p); return true; } catch { return false; } }
function tree(dir) {
  const out = [];
  (function w(d) {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      out.push(path.relative(dir, p) + (st.isSymbolicLink() ? ' -> ' + fs.readlinkSync(p) : ''));
      if (st.isDirectory()) w(p);
    }
  })(dir);
  return out;
}
const statuses = (r, kind) => r.actions.filter((a) => !kind || a.kind === kind).map((a) => a.status);
const backups = (dir) => tree(dir).filter((p) => p.includes('.shufi-backup'));

// Python's tomllib is a real TOML parser; use it when python3 is around.
function tomlParse(file) {
  const r = spawnSync('python3', ['-c', 'import sys,tomllib,json;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))', file], { encoding: 'utf8' });
  if (r.error || (r.status !== 0 && /No module named|tomllib/.test(r.stderr))) return null;
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// ------------------------------------------------------------------ Codex

test('codex: fresh install writes instructions, hook, MCP block and skill links', () => {
  const home = tmp();
  const r = installHost('codex', { home, pluginRoot: ROOT });
  assert.equal(r.ok, true);

  const agents = read(path.join(home, '.codex', 'AGENTS.md'));
  assert.match(agents, /shufi \(managed by/);
  assert.match(agents, /~\/\.jarvis-hub-path/);
  assert.ok(agents.includes(ROOT), 'tells the agent what ${CLAUDE_PLUGIN_ROOT} means');

  const hooks = JSON.parse(read(path.join(home, '.codex', 'hooks.json')));
  const h = hooks.hooks.SessionStart[0].hooks[0];
  assert.equal(h.type, 'command');
  assert.equal(h.command, `node ${JSON.stringify(path.join(ROOT, 'hooks', 'session-start.mjs'))} --host codex`);
  assert.equal(hooks.hooks.SessionStart[0].matcher, 'startup|resume|clear');

  const toml = read(path.join(home, '.codex', 'config.toml'));
  assert.match(toml, /\[mcp_servers\.playwright\]\ncommand = "npx"\nargs = \["-y", "@playwright\/mcp@latest"\]\nstartup_timeout_sec = 60/);
  assert.doesNotMatch(toml, /context7|supabase/, 'only the recommended, keyless servers by default');
  const parsed = tomlParse(path.join(home, '.codex', 'config.toml'));
  if (parsed) assert.deepEqual(parsed.mcp_servers.playwright, { command: 'npx', args: ['-y', '@playwright/mcp@latest'], startup_timeout_sec: 60 });

  const skillsDir = path.join(home, '.agents', 'skills');
  const ids = listSkills(ROOT);
  assert.ok(ids.length >= 12);
  for (const id of ids) assert.ok(exists(path.join(skillsDir, id, 'SKILL.md')), id);
  assert.equal(fs.lstatSync(path.join(skillsDir, 'done')).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(skillsDir, 'done')), path.join(ROOT, 'skills', 'done'));
});

test('codex: a SKILL.md with a leading HTML comment is copied with frontmatter first (strict parsers)', () => {
  const root = fakeRoot();
  fs.mkdirSync(path.join(root, 'skills', 'three'));
  fs.writeFileSync(path.join(root, 'skills', 'three', 'SKILL.md'), '<!-- licence -->\n---\nname: three\ndescription: three\n---\nbody\n');
  fs.writeFileSync(path.join(root, 'setup', 'skills-catalog.json'), JSON.stringify({ skills: [{ id: 'one' }, { id: 'two' }, { id: 'three' }] }));
  const home = tmp();
  installHost('codex', { home, pluginRoot: root });
  const dest = path.join(home, '.agents', 'skills', 'three');
  assert.equal(fs.lstatSync(dest).isSymbolicLink(), false, 'a copy, because the source cannot be linked as-is');
  assert.equal(read(path.join(dest, 'SKILL.md')), '---\nname: three\ndescription: three\n---\n\n<!-- licence -->\nbody\n');
  assert.equal(fs.lstatSync(path.join(home, '.agents', 'skills', 'one')).isSymbolicLink(), true);
  assert.deepEqual(statuses(installHost('codex', { home, pluginRoot: root }), 'skill'), ['unchanged', 'unchanged', 'unchanged']);
});

test('every shipped SKILL.md starts with frontmatter (Codex and Cursor need --- on line 1)', () => {
  for (const dir of ['skills', 'optional-skills']) {
    for (const id of fs.readdirSync(path.join(ROOT, dir))) {
      const f = path.join(ROOT, dir, id, 'SKILL.md');
      assert.match(read(f), /^---\nname: /, f);
      assert.match(read(f).split('\n---')[0], new RegExp('name: ' + id + '\\b'), f + ': name matches folder');
    }
  }
});

test('codex: second install changes nothing and writes no backup', () => {
  const home = tmp();
  installHost('codex', { home, pluginRoot: ROOT });
  const before = tree(home);
  const files = ['AGENTS.md', 'hooks.json', 'config.toml'].map((f) => [f, read(path.join(home, '.codex', f))]);
  const r = installHost('codex', { home, pluginRoot: ROOT });
  assert.ok(statuses(r).every((s) => s === 'unchanged'), JSON.stringify(statuses(r)));
  assert.deepEqual(tree(home), before);
  for (const [f, text] of files) assert.equal(read(path.join(home, '.codex', f)), text);
  assert.deepEqual(backups(home), []);
});

test('codex: uninstall removes everything it added and leaves an empty home', () => {
  const home = tmp();
  installHost('codex', { home, pluginRoot: ROOT });
  const r = uninstallHost('codex', { home, pluginRoot: ROOT });
  assert.equal(r.ok, true);
  const left = tree(home).filter((p) => !/^\.codex$|^\.agents$/.test(p));
  assert.deepEqual(left, []);
  // And a second uninstall is a no-op.
  assert.deepEqual(uninstallHost('codex', { home, pluginRoot: ROOT }).actions, []);
});

test('codex: user content survives install and uninstall byte for byte; edited files are backed up', () => {
  const home = tmp();
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const agents = '# My rules\n\nAlways answer in French.\n';
  const toml = 'model = "gpt-5"\n\n[projects."/work"]\ntrust_level = "trusted"\n';
  const hooks = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } };
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), agents);
  fs.writeFileSync(path.join(dir, 'config.toml'), toml);
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify(hooks, null, 2) + '\n');

  installHost('codex', { home, pluginRoot: ROOT });
  assert.ok(read(path.join(dir, 'AGENTS.md')).startsWith(agents));
  assert.ok(read(path.join(dir, 'config.toml')).startsWith(toml));
  const merged = JSON.parse(read(path.join(dir, 'hooks.json')));
  assert.equal(merged.hooks.SessionStart.length, 2);
  assert.equal(merged.hooks.SessionStart[0].hooks[0].command, 'echo mine');
  assert.deepEqual(merged.hooks.Stop, hooks.hooks.Stop);
  const parsed = tomlParse(path.join(dir, 'config.toml'));
  if (parsed) { assert.equal(parsed.model, 'gpt-5'); assert.ok(parsed.mcp_servers.playwright); }
  assert.equal(backups(home).length, 3, 'one backup per file that existed: ' + backups(home));
  const bak = backups(home).find((p) => p.includes('AGENTS.md'));
  assert.equal(read(path.join(home, bak)), agents, 'the backup is the original');

  uninstallHost('codex', { home, pluginRoot: ROOT });
  assert.equal(read(path.join(dir, 'AGENTS.md')), agents);
  assert.equal(read(path.join(dir, 'config.toml')), toml);
  assert.deepEqual(JSON.parse(read(path.join(dir, 'hooks.json'))), hooks);
});

test('codex: a server the user already defined is left alone (a duplicate table would break config.toml)', () => {
  const home = tmp();
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const toml = '[mcp_servers.playwright]\ncommand = "my-playwright"\n';
  fs.writeFileSync(path.join(dir, 'config.toml'), toml);
  const r = installHost('codex', { home, pluginRoot: ROOT });
  assert.ok(r.actions.some((a) => a.kind === 'mcp' && a.status === 'skipped' && /playwright/.test(a.detail)));
  assert.equal(read(path.join(dir, 'config.toml')), toml);
});

test('codex: AGENTS.override.md wins over AGENTS.md, so the block goes there', () => {
  const home = tmp();
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENTS.override.md'), 'override\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'plain\n');
  installHost('codex', { home, pluginRoot: ROOT });
  assert.match(read(path.join(dir, 'AGENTS.override.md')), /shufi \(managed/);
  assert.equal(read(path.join(dir, 'AGENTS.md')), 'plain\n');
  uninstallHost('codex', { home, pluginRoot: ROOT });
  assert.equal(read(path.join(dir, 'AGENTS.override.md')), 'override\n');
});

test('codex: an empty AGENTS.override.md is skipped by Codex, so the block goes to AGENTS.md', () => {
  const home = tmp();
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENTS.override.md'), '  \n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'plain\n');
  installHost('codex', { home, pluginRoot: ROOT });
  assert.match(read(path.join(dir, 'AGENTS.md')), /shufi \(managed/);
  assert.equal(read(path.join(dir, 'AGENTS.override.md')), '  \n');
  uninstallHost('codex', { home, pluginRoot: ROOT });
  assert.equal(read(path.join(dir, 'AGENTS.md')), 'plain\n');
});

test('codex: invalid hooks.json is reported and left untouched', () => {
  const home = tmp();
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks.json'), '{ nope');
  const r = installHost('codex', { home, pluginRoot: ROOT });
  assert.equal(r.ok, false);
  assert.equal(read(path.join(dir, 'hooks.json')), '{ nope');
  assert.deepEqual(backups(home), []);
});

test('codex: a skill folder the user made is never replaced or removed', () => {
  const home = tmp();
  const mine = path.join(home, '.agents', 'skills', 'done');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'SKILL.md'), '---\nname: done\ndescription: mine\n---\n');
  const r = installHost('codex', { home, pluginRoot: ROOT });
  assert.ok(r.actions.some((a) => a.kind === 'skill' && a.status === 'skipped' && a.path === mine));
  uninstallHost('codex', { home, pluginRoot: ROOT });
  assert.match(read(path.join(mine, 'SKILL.md')), /description: mine/);
});

test('codex: --mcp none, --no-skills, --no-hook, --no-instructions each skip their part', () => {
  const home = tmp();
  installHost('codex', { home, pluginRoot: ROOT, mcp: 'none', skills: false, hook: false, instructions: false });
  assert.deepEqual(tree(home), []);
});

test('codex: --mcp all adds the keyed/optional servers, keys come from env vars and are never written', () => {
  const root = fakeRoot();
  const home = tmp();
  installHost('codex', { home, pluginRoot: root, mcp: 'all' });
  const toml = read(path.join(home, '.codex', 'config.toml'));
  assert.match(toml, /\[mcp_servers\.alpha\]\nurl = "https:\/\/alpha\.example\/mcp"\nbearer_token_env_var = "JARVIS_MCP_ALPHA_TOKEN"/);
  assert.match(toml, /\[mcp_servers\.beta-two\]\ncommand = "npx"\nargs = \["-y", "beta"\]\nstartup_timeout_sec = 60/);
  const parsed = tomlParse(path.join(home, '.codex', 'config.toml'));
  if (parsed) assert.equal(parsed.mcp_servers.alpha.bearer_token_env_var, 'JARVIS_MCP_ALPHA_TOKEN');
});

test('codex: MCP selection is additive across runs (install-host --mcp x never drops what is there)', () => {
  const root = fakeRoot();
  const home = tmp();
  installHost('codex', { home, pluginRoot: root });                       // beta-two (default)
  installHost('codex', { home, pluginRoot: root, mcp: ['alpha'], skills: false, hook: false, instructions: false });
  let toml = read(path.join(home, '.codex', 'config.toml'));
  assert.match(toml, /mcp_servers\.beta-two/);
  assert.match(toml, /mcp_servers\.alpha/);
  installHost('codex', { home, pluginRoot: root, mcp: 'none' });
  assert.equal(read(path.join(home, '.codex', 'config.toml')), toml);
  const parsed = tomlParse(path.join(home, '.codex', 'config.toml'));
  if (parsed) assert.deepEqual(Object.keys(parsed.mcp_servers).sort(), ['alpha', 'beta-two']);
});

test('codex: skills that are no longer enabled are pruned on the next install', () => {
  const root = fakeRoot();
  const home = tmp();
  installHost('codex', { home, pluginRoot: root });
  assert.ok(exists(path.join(home, '.agents', 'skills', 'two')));
  fs.rmSync(path.join(root, 'skills', 'two'), { recursive: true });
  const r = installHost('codex', { home, pluginRoot: root });
  assert.ok(r.actions.some((a) => a.status === 'removed' && a.path.endsWith('two')));
  assert.equal(exists(path.join(home, '.agents', 'skills', 'two')), false);
  assert.ok(exists(path.join(home, '.agents', 'skills', 'one')));
});

test('codex: --dry-run reports and writes nothing', () => {
  const home = tmp();
  const r = installHost('codex', { home, pluginRoot: ROOT, dryRun: true });
  assert.ok(r.actions.length > 5);
  assert.deepEqual(tree(home), []);
});

test('codex: CODEX_HOME is honoured for the config dir', () => {
  const home = tmp();
  const codexHome = path.join(tmp(), 'elsewhere');
  installHost('codex', { home, codexHome, pluginRoot: ROOT, skills: false });
  assert.ok(exists(path.join(codexHome, 'AGENTS.md')));
  assert.equal(exists(path.join(home, '.codex')), false);
});

test('codex: host-status reflects install and uninstall', () => {
  const home = tmp();
  const ok = (r) => Object.fromEntries(r.rows.map((x) => [x.item, x.ok]));
  assert.deepEqual(ok(hostStatus('codex', { home, pluginRoot: ROOT })), { instructions: false, hook: false, mcp: false, skills: false });
  installHost('codex', { home, pluginRoot: ROOT });
  assert.deepEqual(ok(hostStatus('codex', { home, pluginRoot: ROOT })), { instructions: true, hook: true, mcp: true, skills: true });
  uninstallHost('codex', { home, pluginRoot: ROOT });
  assert.deepEqual(ok(hostStatus('codex', { home, pluginRoot: ROOT })), { instructions: false, hook: false, mcp: false, skills: false });
});

// ------------------------------------------------------------------ Cursor

test('cursor: fresh install writes hook, mcp.json and skill copies', () => {
  const home = tmp();
  const r = installHost('cursor', { home, pluginRoot: ROOT });
  assert.equal(r.ok, true);
  const hooks = JSON.parse(read(path.join(home, '.cursor', 'hooks.json')));
  assert.equal(hooks.version, 1);
  assert.equal(hooks.hooks.sessionStart[0].command, `node ${JSON.stringify(path.join(ROOT, 'hooks', 'session-start.mjs'))} --host cursor`);
  const mcp = JSON.parse(read(path.join(home, '.cursor', 'mcp.json')));
  assert.deepEqual(mcp.mcpServers.playwright, { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] });
  const skill = path.join(home, '.cursor', 'skills', 'done');
  assert.equal(fs.lstatSync(skill).isSymbolicLink(), false, 'copied, not linked');
  assert.ok(exists(path.join(skill, 'scripts', 'update-context.py')));
  assert.ok(exists(path.join(skill, '.shufi-managed')));
  assert.equal(exists(path.join(skill, '.jarvis-os-managed')), false);
  assert.equal(exists(path.join(home, '.cursor', 'rules')), false, 'no project rule without --project');
});

test('cursor: second install changes nothing; a changed skill is refreshed', () => {
  const root = fakeRoot();
  const home = tmp();
  installHost('cursor', { home, pluginRoot: root });
  const before = tree(home);
  const r = installHost('cursor', { home, pluginRoot: root });
  assert.ok(statuses(r).every((s) => s === 'unchanged'), JSON.stringify(statuses(r)));
  assert.deepEqual(tree(home), before);
  assert.deepEqual(backups(home), []);

  fs.appendFileSync(path.join(root, 'skills', 'one', 'SKILL.md'), '\nmore\n');
  const r2 = installHost('cursor', { home, pluginRoot: root });
  assert.deepEqual(r2.actions.filter((a) => a.status === 'updated').map((a) => path.basename(a.path)), ['one']);
  assert.match(read(path.join(home, '.cursor', 'skills', 'one', 'SKILL.md')), /more/);
});

test('cursor: uninstall removes everything it added', () => {
  const home = tmp();
  const proj = tmp();
  installHost('cursor', { home, pluginRoot: ROOT, project: proj });
  assert.ok(exists(path.join(proj, '.cursor', 'rules', 'jarvis-hub.mdc')));
  uninstallHost('cursor', { home, pluginRoot: ROOT, project: proj });
  assert.deepEqual(tree(home).filter((p) => p !== '.cursor'), []);
  assert.equal(exists(path.join(proj, '.cursor', 'rules', 'jarvis-hub.mdc')), false);
});

test('cursor: user hooks and servers survive; a same-named different server is skipped', () => {
  const home = tmp();
  const dir = path.join(home, '.cursor');
  fs.mkdirSync(dir, { recursive: true });
  const hooks = { version: 1, hooks: { sessionStart: [{ command: './mine.sh' }], stop: [{ command: './bye.sh' }] } };
  const mcp = { mcpServers: { playwright: { command: 'my-own' }, other: { url: 'https://o.example/mcp' } } };
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify(hooks, null, 2));
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(mcp, null, 2));
  const r = installHost('cursor', { home, pluginRoot: ROOT, skills: false });
  assert.ok(r.actions.some((a) => a.kind === 'mcp' && a.status === 'skipped' && /playwright/.test(a.detail)));
  assert.deepEqual(JSON.parse(read(path.join(dir, 'mcp.json'))), mcp);
  const merged = JSON.parse(read(path.join(dir, 'hooks.json')));
  assert.equal(merged.hooks.sessionStart.length, 2);
  assert.equal(merged.hooks.sessionStart[0].command, './mine.sh');
  assert.equal(backups(home).length, 1, 'hooks.json backed up; mcp.json was not modified');

  uninstallHost('cursor', { home, pluginRoot: ROOT });
  assert.deepEqual(JSON.parse(read(path.join(dir, 'hooks.json'))), hooks);
  assert.deepEqual(JSON.parse(read(path.join(dir, 'mcp.json'))), mcp);
});

test('cursor: our mcp entry is removed on uninstall, others in the same file stay', () => {
  const home = tmp();
  const dir = path.join(home, '.cursor');
  fs.mkdirSync(dir, { recursive: true });
  const other = { mcpServers: { other: { url: 'https://o.example/mcp' } } };
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(other));
  installHost('cursor', { home, pluginRoot: ROOT, skills: false, hook: false });
  assert.ok(JSON.parse(read(path.join(dir, 'mcp.json'))).mcpServers.playwright);
  uninstallHost('cursor', { home, pluginRoot: ROOT });
  assert.deepEqual(JSON.parse(read(path.join(dir, 'mcp.json'))), other);
});

test('cursor: keyed servers reference an env var with Cursor interpolation', () => {
  const root = fakeRoot();
  const home = tmp();
  installHost('cursor', { home, pluginRoot: root, mcp: ['alpha'], skills: false, hook: false });
  const mcp = JSON.parse(read(path.join(home, '.cursor', 'mcp.json')));
  assert.deepEqual(mcp.mcpServers.alpha, { url: 'https://alpha.example/mcp', headers: { Authorization: 'Bearer ${env:JARVIS_MCP_ALPHA_TOKEN}' } });
});

test('cursor: --project writes one wholly-owned alwaysApply rule and never overwrites a user file', () => {
  const home = tmp();
  const proj = tmp();
  installHost('cursor', { home, pluginRoot: ROOT, project: proj, skills: false, hook: false, mcp: 'none' });
  const rule = read(path.join(proj, '.cursor', 'rules', 'jarvis-hub.mdc'));
  assert.match(rule, /^---\ndescription: .*\nalwaysApply: true\n---\n/);
  assert.match(rule, /~\/\.jarvis-hub-path/);

  const proj2 = tmp();
  fs.mkdirSync(path.join(proj2, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(proj2, '.cursor', 'rules', 'jarvis-hub.mdc'), 'mine\n');
  const r = installHost('cursor', { home, pluginRoot: ROOT, project: proj2, skills: false, hook: false, mcp: 'none' });
  assert.ok(r.actions.some((a) => a.kind === 'rule' && a.status === 'skipped'));
  assert.equal(read(path.join(proj2, '.cursor', 'rules', 'jarvis-hub.mdc')), 'mine\n');
});

test('cursor: invalid mcp.json is reported and left untouched', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), '{ // comment\n}');
  const r = installHost('cursor', { home, pluginRoot: ROOT, skills: false, hook: false });
  assert.equal(r.ok, false);
  assert.equal(read(path.join(home, '.cursor', 'mcp.json')), '{ // comment\n}');
});

// ------------------------------------------------------------------ the hook

function runHook(args, env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-start.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
}

function fakeHub() {
  const home = tmp();
  const hub = path.join(home, 'hub');
  fs.mkdirSync(hub);
  fs.writeFileSync(path.join(hub, 'MEMORY.md'), '# Memory\n- likes tea\n');
  fs.writeFileSync(path.join(hub, 'working-rules.md'), 'be brief\n');
  return { home, hub };
}

test('hook: no flag prints exactly what Claude Code always got (no plugin-root note)', () => {
  const { home, hub } = fakeHub();
  const r = runHook([], { HOME: home, JARVIS_HUB: hub });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `# Shufi memory (${hub}/MEMORY.md)\n\n# Memory\n- likes tea\n\n\n# Working rules (${hub}/working-rules.md)\n\nbe brief\n`);
});

test('hook: --host codex prints plain text with the plugin root note', () => {
  const { home, hub } = fakeHub();
  const r = runHook(['--host', 'codex'], { HOME: home, JARVIS_HUB: hub });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^# Shufi memory/);
  assert.match(r.stdout, /likes tea/);
  assert.ok(r.stdout.includes('Plugin root on this host: ' + ROOT));
});

test('hook: --host cursor prints JSON with additional_context', () => {
  const { home, hub } = fakeHub();
  const r = runHook(['--host', 'cursor'], { HOME: home, JARVIS_HUB: hub });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.additional_context, /likes tea/);
  assert.match(out.additional_context, /be brief/);
});

test('hook: hub found through ~/.jarvis-hub-path, and unconfigured prints a host-correct nudge', () => {
  const { home, hub } = fakeHub();
  fs.writeFileSync(path.join(home, '.jarvis-hub-path'), hub + '\n');
  assert.match(runHook(['--host', 'codex'], { HOME: home }).stdout, /likes tea/);
  const bare = tmp();
  const r = runHook(['--host', 'codex'], { HOME: bare });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(path.join(ROOT, 'setup', 'agent.mjs') + '" plan'));
  assert.doesNotMatch(r.stdout, /\$CLAUDE_PLUGIN_ROOT\/setup/);
});

test('hook: the exact command each adapter registers runs under sh and loads the hub', () => {
  const { home: hubHome, hub } = fakeHub();
  const home = tmp();
  installHost('codex', { home, pluginRoot: ROOT, skills: false, mcp: 'none', instructions: false });
  installHost('cursor', { home, pluginRoot: ROOT, skills: false, mcp: 'none' });
  const codexCmd = JSON.parse(read(path.join(home, '.codex', 'hooks.json'))).hooks.SessionStart[0].hooks[0].command;
  const cursorCmd = JSON.parse(read(path.join(home, '.cursor', 'hooks.json'))).hooks.sessionStart[0].command;
  const env = { PATH: process.env.PATH, HOME: hubHome, JARVIS_HUB: hub };
  const c = spawnSync('sh', ['-c', codexCmd], { encoding: 'utf8', env, input: '{"hook_event_name":"SessionStart","source":"startup"}', cwd: os.tmpdir() });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /likes tea/);
  const u = spawnSync('sh', ['-c', cursorCmd], { encoding: 'utf8', env, input: '{"session_id":"x"}', cwd: path.join(home, '.cursor') });
  assert.equal(u.status, 0, u.stderr);
  assert.match(JSON.parse(u.stdout).additional_context, /likes tea/);
});

// ------------------------------------------------------------------ the CLI

test('cli: install-host / host-status / uninstall-host through setup/agent.mjs under a fake HOME', () => {
  const home = tmp();
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'setup', 'agent.mjs'), ...a], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  const inst = run('install-host', 'codex', '--json');
  assert.equal(inst.status, 0, inst.stderr);
  assert.equal(JSON.parse(inst.stdout).ok, true);
  assert.ok(exists(path.join(home, '.codex', 'AGENTS.md')));
  const st = JSON.parse(run('host-status', 'codex', '--json').stdout);
  assert.ok(st.rows.every((x) => x.ok));
  assert.equal(run('uninstall-host', 'codex').status, 0);
  assert.deepEqual(tree(home).filter((p) => !/^\.codex$|^\.agents$/.test(p)), []);
  assert.equal(run('install-host', 'nope').status, 2);
  assert.match(run('install-host', 'cursor', '--print-user-rule').stdout, /Shufi memory/);
  assert.equal(exists(path.join(home, '.cursor')), false, '--print-user-rule writes nothing');
  const c = run('connect', 'context7', '--host', 'cursor');
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.ok(JSON.parse(read(path.join(home, '.cursor', 'mcp.json'))).mcpServers.context7);
});

// ------------------------------------------------------------------ legacy (jarvis-os) markers

const L_MD_OPEN = '<!-- >>> jarvis-os (managed by setup/agent.mjs install-host; remove with uninstall-host) >>> -->';
const L_MD_CLOSE = '<!-- <<< jarvis-os <<< -->';
const L_TOML_OPEN = '# >>> jarvis-os (managed by setup/agent.mjs install-host; remove with uninstall-host) >>>';
const L_TOML_CLOSE = '# <<< jarvis-os <<<';
const L_RULE = '<!-- jarvis-os managed rule: remove with uninstall-host -->';
const count = (text, needle) => text.split(needle).length - 1;

// Seed a home with what the old release wrote.
function seedLegacyCodex(home) {
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'AGENTS.md'), `# mine\n\n${L_MD_OPEN}\n## Jarvis memory (jarvis-os)\nold text\n${L_MD_CLOSE}\n\ntail\n`);
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `model = "x"\n\n${L_TOML_OPEN}\n[mcp_servers.playwright]\ncommand = "npx"\nargs = ["-y", "@playwright/mcp@latest"]\nstartup_timeout_sec = 60\n${L_TOML_CLOSE}\n`);
}

function seedLegacySkill(dir, id, root) {
  const dest = path.join(dir, id);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), 'old\n');
  fs.writeFileSync(path.join(dest, '.jarvis-os-managed'), JSON.stringify({ source: path.join(root, 'skills', id), hash: 'stale' }));
  return dest;
}

test('legacy: codex install over jarvis-os blocks leaves exactly one shufi block and no legacy one', () => {
  const home = tmp();
  seedLegacyCodex(home);
  const r = installHost('codex', { home, pluginRoot: ROOT });
  assert.equal(r.ok, true, JSON.stringify(r.actions));

  const agents = read(path.join(home, '.codex', 'AGENTS.md'));
  assert.equal(count(agents, '>>> shufi ('), 1);
  assert.equal(count(agents, '<!-- <<< shufi <<< -->'), 1);
  assert.doesNotMatch(agents, /jarvis-os/);
  assert.doesNotMatch(agents, /old text/);
  assert.match(agents, /## Shufi memory/);
  assert.ok(agents.startsWith('# mine\n\n') && agents.includes('\ntail\n'), 'user text around the block survives, block stays in place');

  const toml = read(path.join(home, '.codex', 'config.toml'));
  assert.equal(count(toml, '# >>> shufi ('), 1);
  assert.equal(count(toml, '# <<< shufi <<<'), 1);
  assert.doesNotMatch(toml, /jarvis-os/);
  assert.equal(count(toml, '[mcp_servers.playwright]'), 1, 'server from the legacy block is not duplicated');
  assert.ok(toml.startsWith('model = "x"\n'));

  // second run: nothing left to change
  const before = tree(home);
  const r2 = installHost('codex', { home, pluginRoot: ROOT });
  assert.ok(r2.actions.every((a) => a.status === 'unchanged'), JSON.stringify(r2.actions));
  assert.deepEqual(tree(home), before);

  const st = hostStatus('codex', { home, pluginRoot: ROOT });
  assert.ok(st.rows.every((x) => x.ok), JSON.stringify(st.rows));
});

test('legacy: status and server-skip see a jarvis-os-only codex install', () => {
  const home = tmp();
  seedLegacyCodex(home);
  const st = hostStatus('codex', { home, pluginRoot: ROOT });
  assert.equal(st.rows.find((x) => x.item === 'instructions').ok, true);
  assert.equal(st.rows.find((x) => x.item === 'mcp').detail, 'playwright');
  // a legacy-block server is ours, not the user's: install must not skip it as "you already defined"
  const r = installHost('codex', { home, pluginRoot: ROOT, skills: false, hook: false, instructions: false });
  assert.equal(statuses(r, 'mcp').includes('skipped'), false, JSON.stringify(r.actions));
});

test('legacy: a skill dir holding only .jarvis-os-managed counts as managed and is upgraded', () => {
  const root = fakeRoot();
  const home = tmp();
  const skillsDir = path.join(home, '.cursor', 'skills');
  const dest = seedLegacySkill(skillsDir, 'one', root);
  const r = installHost('cursor', { home, pluginRoot: root, hook: false, mcp: 'none' });
  assert.equal(r.ok, true);
  const one = r.actions.find((a) => a.kind === 'skill' && path.basename(a.path) === 'one');
  assert.notEqual(one.status, 'skipped', 'legacy marker means managed');
  assert.match(read(path.join(dest, 'SKILL.md')), /name: one/);
  assert.ok(exists(path.join(dest, '.shufi-managed')));
  assert.equal(exists(path.join(dest, '.jarvis-os-managed')), false);

  // same content + legacy marker only: marker is swapped, content kept
  fs.rmSync(path.join(dest, '.shufi-managed'));
  const h = JSON.parse(read(path.join(skillsDir, 'two', '.shufi-managed'))).hash;
  fs.writeFileSync(path.join(skillsDir, 'two', '.jarvis-os-managed'), JSON.stringify({ source: 'x', hash: h }));
  fs.rmSync(path.join(skillsDir, 'two', '.shufi-managed'));
  const r2 = installHost('cursor', { home, pluginRoot: root, hook: false, mcp: 'none' });
  const two = r2.actions.find((a) => a.kind === 'skill' && path.basename(a.path) === 'two');
  assert.equal(two.status, 'updated');
  assert.ok(exists(path.join(skillsDir, 'two', '.shufi-managed')));
  assert.equal(exists(path.join(skillsDir, 'two', '.jarvis-os-managed')), false);

  // a dir with neither marker is still foreign
  const foreign = path.join(skillsDir, 'three');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'SKILL.md'), 'mine\n');
  assert.equal(skillsKept(home, root, 'three'), 'mine\n');
});

function skillsKept(home, root, id) {
  installHost('cursor', { home, pluginRoot: root, hook: false, mcp: 'none' });
  return read(path.join(home, '.cursor', 'skills', id, 'SKILL.md'));
}

test('legacy: cursor project rule with the jarvis-os marker is ours and is rewritten with the shufi marker', () => {
  const home = tmp();
  const proj = tmp();
  const file = path.join(proj, '.cursor', 'rules', 'jarvis-hub.mdc');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: Jarvis memory hub\nalwaysApply: true\n---\n${L_RULE}\n\nold\n`);
  assert.equal(hostStatus('cursor', { home, pluginRoot: ROOT, project: proj }).rows.find((x) => x.item === 'project rule').ok, true);
  const r = installHost('cursor', { home, pluginRoot: ROOT, project: proj, skills: false, hook: false, mcp: 'none' });
  assert.equal(statuses(r, 'rule')[0], 'updated');
  const rule = read(file);
  assert.ok(rule.includes('<!-- shufi managed rule:'));
  assert.equal(rule.includes('jarvis-os'), false);
  assert.match(rule, /description: Shufi memory hub/);
});

test('legacy: uninstall-host on a jarvis-os-only codex install removes everything', () => {
  const root = fakeRoot();
  const home = tmp();
  seedLegacyCodex(home);
  seedLegacySkill(path.join(home, '.agents', 'skills'), 'one', root);
  const r = uninstallHost('codex', { home, pluginRoot: ROOT });
  assert.equal(r.ok, true, JSON.stringify(r.actions));
  const agents = read(path.join(home, '.codex', 'AGENTS.md'));
  assert.doesNotMatch(agents, /jarvis-os|Jarvis memory|old text/);
  assert.equal(agents, '# mine\n\ntail\n');
  assert.equal(read(path.join(home, '.codex', 'config.toml')), 'model = "x"\n');
  assert.equal(exists(path.join(home, '.agents', 'skills')), false, 'legacy-managed skill removed, empty dir pruned');
});

test('legacy: uninstall-host on a jarvis-os-only cursor install removes skills and the project rule', () => {
  const root = fakeRoot();
  const home = tmp();
  const proj = tmp();
  seedLegacySkill(path.join(home, '.cursor', 'skills'), 'one', root);
  const file = path.join(proj, '.cursor', 'rules', 'jarvis-hub.mdc');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nalwaysApply: true\n---\n${L_RULE}\n\nold\n`);
  const r = uninstallHost('cursor', { home, pluginRoot: root, project: proj });
  assert.equal(r.ok, true);
  assert.equal(exists(file), false);
  assert.equal(exists(path.join(home, '.cursor', 'skills')), false);
});

test('legacy: a codex file that is only a jarvis-os block is deleted on uninstall; damaged legacy markers are left alone', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const f = path.join(home, '.codex', 'AGENTS.md');
  fs.writeFileSync(f, `${L_MD_OPEN}\nbody\n${L_MD_CLOSE}\n`);
  uninstallHost('codex', { home, pluginRoot: ROOT });
  assert.equal(exists(f), false);

  const broken = `keep\n${L_MD_OPEN}\nbody, no close\n`;
  fs.writeFileSync(f, broken);
  const r = installHost('codex', { home, pluginRoot: ROOT, skills: false, hook: false, mcp: 'none' });
  assert.equal(r.ok, false);
  assert.equal(read(f), broken);
});

// ------------------------------------------------------------------ fixtures

// A small plugin root: two skills, one keyed and one stdio server.
function fakeRoot() {
  const root = tmp();
  for (const id of ['one', 'two']) {
    fs.mkdirSync(path.join(root, 'skills', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', id, 'SKILL.md'), `---\nname: ${id}\ndescription: ${id}\n---\nbody\n`);
  }
  fs.mkdirSync(path.join(root, 'setup'));
  fs.writeFileSync(path.join(root, 'setup', 'skills-catalog.json'), JSON.stringify({ skills: [{ id: 'one' }, { id: 'two' }] }));
  fs.writeFileSync(path.join(root, 'setup', 'tools-catalog.json'), JSON.stringify({ tools: [
    { id: 'alpha', kind: 'mcp', default: false, secret: { label: 'Key' }, mcp: { transport: 'http', url: 'https://alpha.example/mcp', header_secret: true } },
    { id: 'beta-two', kind: 'mcp', default: true, secret: null, mcp: { transport: 'stdio', command: ['npx', '-y', 'beta'] } },
    { id: 'git', kind: 'cli' },
  ] }));
  return root;
}
