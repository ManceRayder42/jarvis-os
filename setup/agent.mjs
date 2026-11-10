#!/usr/bin/env node
// setup/agent.mjs -- the setup page, for agents.
//
// Everything a person can press on the /jarvis-setup page, an agent can run
// from here: read the same checklist, create the memory, switch skills,
// install or connect tools. It does not re-implement any of it. It starts
// setup/server.mjs as a child, talks to the same loopback API the page uses
// (same token, same allowlists, same safety model), and stops it on exit --
// so the page and the agent can never disagree about what a step does.
//
// One rule the page can bend and this cannot: an agent never sees a secret.
// `connect` for a tool that needs a key reads it from the terminal with echo
// off, so the person types it and the agent only sees "connected" or not.
//
//   node setup/agent.mjs status [--json]
//   node setup/agent.mjs setup [--hub <path>]
//   node setup/agent.mjs skills [--json]
//   node setup/agent.mjs enable <skill-id>... | disable <skill-id>...
//   node setup/agent.mjs tools [--json]
//   node setup/agent.mjs install <tool-id>...
//   node setup/agent.mjs connect <tool-id>          (asks for a key on the TTY when one is needed)
//   node setup/agent.mjs obsidian <vault-path>
//   node setup/agent.mjs plan [--json]              (what is left, in order, and who has to do it)
//   node setup/agent.mjs install-host codex|cursor  (wire Codex CLI or Cursor to the memory, skills and tools)
//   node setup/agent.mjs uninstall-host codex|cursor
//   node setup/agent.mjs host-status codex|cursor
//
// Exit code: 0 when the command did what it says, 1 when any part failed,
// 2 on bad usage.

import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const json = argv.includes('--json');
const fromClipboard = argv.includes('--from-clipboard');
// --host codex|cursor (or JARVIS_HOST) points status/plan/connect at that host instead of Claude Code.
const hostIdx = argv.indexOf('--host');
const HOST = (hostIdx >= 0 ? argv[hostIdx + 1] : process.env.JARVIS_HOST) || '';
if (HOST && !/^(codex|cursor)$/.test(HOST)) { console.error('--host takes codex or cursor'); process.exit(2); }
const rest = argv.slice(1).filter((a, i, all) => a !== '--json' && a !== '--from-clipboard' && a !== '--host' && all[i - 1] !== '--host');
// Plan lines print an absolute command, so an agent (or a person) can run them
// from any directory without knowing where the plugin is installed.
const SELF = 'node "' + path.join(__dirname, 'agent.mjs') + '"';

const USAGE = `usage: node setup/agent.mjs <command>
  status | plan | skills | tools          read the checklist (add --json for machine output)
  setup [--hub <path>]                    create the memory, history, default skills, free tools
  enable <id>... | disable <id>...        switch skills
  install <id>...                         install programs from the Tools list
  connect <id> [--from-clipboard]         connect a connection (a key comes from a hidden prompt or the clipboard, never an argument)
  obsidian <vault-path>                   link the memory into an Obsidian vault
  install-host <codex|cursor> [--mcp default|none|all|id,id] [--no-skills] [--no-hook] [--no-instructions]
                              [--skills link|copy] [--project <dir>] [--print-user-rule] [--dry-run]
                                          use Jarvis OS from Codex CLI or Cursor (backs up what it edits; undo with uninstall-host)
  uninstall-host <codex|cursor> [--project <dir>] [--dry-run]
  host-status <codex|cursor> [--project <dir>]`;

if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); process.exit(cmd ? 0 : 2); }

// ---- host adapters: files only, no server ------------------------------------
if (cmd === 'install-host' || cmd === 'uninstall-host' || cmd === 'host-status') {
  const hosts = await import('./hosts.mjs');
  const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const host = rest[0];
  if (host === 'claude') {
    console.log('Claude Code uses the plugin itself, no host wiring needed:\n  claude plugin marketplace add ManceRayder42/jarvis-os\n  claude plugin install jarvis-os');
    process.exit(0);
  }
  if (!hosts.HOSTS.includes(host)) { console.error('usage: ' + cmd + ' <' + hosts.HOSTS.join('|') + '>\n\n' + USAGE); process.exit(2); }
  if (rest.includes('--print-user-rule')) { process.stdout.write(hosts.userRuleText()); process.exit(0); }
  const mcpFlag = flag('--mcp');
  const opts = {
    dryRun: rest.includes('--dry-run'),
    project: flag('--project'),
    mcp: mcpFlag === undefined ? 'default' : ['default', 'none', 'all'].includes(mcpFlag) ? mcpFlag : mcpFlag.split(',').filter(Boolean),
    skills: !rest.includes('--no-skills'),
    hook: !rest.includes('--no-hook'),
    instructions: !rest.includes('--no-instructions'),
    skillMode: flag('--skills'),
  };
  if (opts.skillMode && !['link', 'copy'].includes(opts.skillMode)) { console.error('--skills takes link or copy'); process.exit(2); }
  let code = 0;
  try {
    if (cmd === 'host-status') {
      const r = hosts.hostStatus(host, opts);
      if (json) console.log(JSON.stringify(r, null, 2));
      else r.rows.forEach((x) => line(x.ok, x.item, x.detail));
    } else {
      const r = cmd === 'install-host' ? hosts.installHost(host, opts) : hosts.uninstallHost(host, opts);
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        const mark = { created: '✓', updated: '✓', removed: '✓', unchanged: '·', skipped: '·', error: '✗' };
        const skills = r.actions.filter((a) => a.kind === 'skill');
        r.actions.filter((a) => a.kind !== 'skill').forEach((a) => console.log(`${mark[a.status]} ${a.kind}: ${a.status}  ${a.path}${a.detail ? '  — ' + a.detail : ''}`));
        if (skills.length) {
          const n = (st) => skills.filter((a) => a.status === st).length;
          console.log(`${skills.some((a) => a.status === 'error') ? '✗' : '✓'} skills: ${n('created')} created, ${n('updated')} updated, ${n('unchanged')} unchanged, ${n('removed')} removed, ${n('skipped')} skipped`);
          skills.filter((a) => a.status === 'skipped').forEach((a) => console.log('    skipped ' + a.path + ' — ' + a.detail));
        }
        if (opts.dryRun) console.log('(dry run: nothing was written)');
        if (cmd === 'install-host') { console.log('\nLimits on ' + host + ':'); hosts.GAPS[host].forEach((g) => console.log('  - ' + g)); }
      }
      if (!r.ok) code = 1;
    }
  } catch (e) { console.error('error: ' + e.message); code = 1; }
  process.exit(code);
}

// ---- the server, as a child ------------------------------------------------
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, JARVIS_HOST: HOST, JARVIS_NO_OPEN: '1' } });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('setup server did not start within 15s')), 15_000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/);
      if (m) { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${m[1]}`, token: m[2] }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('setup server exited early (code ' + code + ')')); });
  });
}

let srv;
async function api(p, body) {
  const res = await fetch(srv.base + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-jarvis-token': srv.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || text || ('HTTP ' + res.status));
  return data;
}
// The server shuts itself down without a heartbeat; long installs would trip it.
let beat;
function keepAlive() { beat = setInterval(() => api('/api/heartbeat', {}).catch(() => {}), 3000); }

// ---- secrets: typed by the person, never seen by the caller --------------
// Two ways in, neither of which puts the key on a command line or in output:
// a hidden prompt on a real terminal, or the clipboard (for places like
// Claude Code's `!` prefix, which may not be a terminal). Never echoed.
function readClipboard() {
  const tries = process.platform === 'darwin' ? [['pbpaste', []]]
    : process.platform === 'win32' ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]]
    : [['wl-paste', ['-n']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['-b', '-o']]];
  for (const [c, a] of tries) {
    try { const v = execFileSync(c, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (v) return v; } catch { /* next */ }
  }
  throw new Error('the clipboard is empty or unreadable — copy the key first');
}
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('this needs a key from a person. They copy the key, then run this same command with --from-clipboard (in Claude Code: type ! followed by the command).'));
      return;
    }
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); resolve(value.trim()); }
      else if (ch === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); reject(new Error('cancelled')); }
      else if (ch === '\u007f') value = value.slice(0, -1);
      else value += ch;
    };
    stdin.on('data', onData);
  });
}

// ---- reading the checklist ------------------------------------------------
async function snapshot() {
  const [cfg, pf, sk, tl] = await Promise.all([
    api('/api/state'), api('/api/preflight?refresh=1'), api('/api/skills'), api('/api/tools'),
  ]);
  return { cfg, preflight: pf.checks || [], skills: sk.skills || [], tools: tl.tools || [] };
}

// The plan is the page's checklist turned into actions, each marked with who
// can do it: `agent` (run the command), `ask` (agent may run it after the
// person agrees -- it installs software), or `person` (needs a key, a login
// or an app only a human can operate).
function buildPlan(s, hostRows) {
  const steps = [];
  const badRequired = s.preflight.filter((c) => c.required && !c.ok);
  badRequired.forEach((c) => steps.push({ step: 'machine', who: 'person', what: 'Fix: ' + c.label, how: c.fix || c.detail }));
  // `setup` itself connects every recommended keyless connection, so before it
  // has run those are folded into its line instead of listed twice.
  const bySetup = (t) => !s.cfg.hub_exists && t.kind === 'mcp' && t.default && !t.secret;
  if (!s.cfg.hub_exists) {
    const also = s.tools.filter((t) => t.state !== 'ready' && bySetup(t)).map((t) => t.name);
    steps.push({ step: 'memory', who: 'agent', what: 'Create the memory folder, turn on default skills' + (also.length ? ', connect ' + also.join(', ') : ''), how: SELF + ' setup' });
  }
  const profileSteps = (s.cfg.profile && s.cfg.profile.steps) || [];
  // For Codex/Cursor the MCP servers are not Claude Code connections: one install-host step covers them.
  const tools = s.tools.filter((t) => t.state !== 'ready' && !bySetup(t) && !(HOST && t.kind === 'mcp'));
  if (HOST && hostRows && hostRows.some((r) => !r.ok)) {
    steps.push({ step: 'host', who: 'agent', what: 'Wire ' + HOST + ' to the memory, skills and tools', how: SELF + ' install-host ' + HOST, then: 'Add --mcp all for the optional servers. See docs/details.md for what ' + HOST + ' cannot do.' });
  }
  const order = (t) => (t.category === 'workspace' ? 0 : 1) + (t.default ? 0 : 2);
  tools.sort((a, b) => order(a) - order(b)).forEach((t) => {
    if (t.kind === 'mcp') {
      const keyed = Boolean(t.secret);
      steps.push({ step: t.category === 'workspace' ? 'workspace' : 'tools', id: t.id, recommended: !!t.default,
        who: keyed ? 'person' : 'agent', what: 'Connect ' + t.name,
        how: keyed ? '! ' + SELF + ' connect ' + t.id + ' --from-clipboard   (the person copies ' + t.secret.label + ', then types this in Claude Code; the key is never shown)'
          : SELF + ' connect ' + t.id,
        then: !keyed && t.after ? t.after : undefined });
    } else if (t.can_install) {
      steps.push({ step: 'tools', id: t.id, recommended: !!t.default, who: t.kind === 'repo' ? 'agent' : 'ask',
        what: (t.kind === 'repo' ? 'Download ' : 'Install ') + t.name, how: SELF + ' install ' + t.id });
    } else if (t.manual) {
      steps.push({ step: 'tools', id: t.id, recommended: !!t.default, who: 'person', what: 'Install ' + t.name, how: t.manual });
    }
  });
  s.tools.filter((t) => t.state === 'ready' && t.after && /sign in/i.test(t.after))
    .forEach((t) => steps.push({ step: 'tools', id: t.id, who: 'person', optional: true, what: t.name + ': one-time sign-in (skip if already signed in)', how: t.after }));
  s.skills.filter((k) => k.enabled && (k.requires || []).length)
    .forEach((k) => steps.push({ step: 'skills', id: k.id, who: 'person', optional: true, what: k.name + ' needs ' + k.requires.join(', '), how: 'enter it on the setup page (/jarvis-setup → Skills)' }));
  if (profileSteps.includes('phone')) steps.push({ step: 'phone', who: 'person', optional: true, what: 'Telegram and voice', how: '/jarvis-setup → Phone & voice' });
  return steps;
}

function hostRows() {
  if (!HOST) return null;
  try { return hostsMod.hostStatus(HOST, {}).rows; } catch { return null; }
}
let hostsMod = null;
if (HOST) hostsMod = await import('./hosts.mjs');

function line(ok, text, extra) { console.log((ok === true ? '✓ ' : ok === false ? '✗ ' : '· ') + text + (extra ? '  — ' + extra : '')); }

// ---- commands -------------------------------------------------------------
const COMMANDS = {
  async status() {
    const s = await snapshot();
    const plan = buildPlan(s, hostRows());
    if (json) return console.log(JSON.stringify({ hub: s.cfg.hub, hub_exists: s.cfg.hub_exists, profile: s.cfg.profile, preflight: s.preflight, skills: s.skills.map(({ id, name, enabled, category }) => ({ id, name, enabled, category })), tools: s.tools.map(({ id, name, kind, state, category, default: d }) => ({ id, name, kind, state, category, default: d })), plan }, null, 2));
    console.log((s.cfg.profile && s.cfg.profile.title) || 'Setup');
    line(!s.preflight.some((c) => c.required && !c.ok), 'Computer', s.preflight.filter((c) => c.ok).length + '/' + s.preflight.length + ' checks');
    line(!!s.cfg.hub_exists, 'Memory', s.cfg.hub_exists ? s.cfg.hub : 'not created');
    line(null, 'Skills', s.skills.filter((k) => k.enabled).length + ' of ' + s.skills.length + ' on');
    const ready = s.tools.filter((t) => t.state === 'ready').length;
    line(ready === s.tools.length ? true : null, 'Tools', ready + ' of ' + s.tools.length + ' ready');
    console.log('\n' + (plan.length ? plan.length + ' step(s) left — run `plan` to see them.' : 'Nothing left to do.'));
  },

  async plan() {
    const plan = buildPlan(await snapshot(), hostRows());
    if (json) return console.log(JSON.stringify(plan, null, 2));
    if (!plan.length) return console.log('Nothing left to do.');
    const WHO = { agent: 'agent', ask: 'agent, after asking', person: 'person' };
    plan.forEach((p, i) => console.log(`${i + 1}. [${WHO[p.who]}] ${p.what}${p.recommended === false || p.optional ? ' (optional)' : ''}\n     ${p.how}${p.then ? '\n     then: ' + p.then : ''}`));
  },

  async setup() {
    const i = rest.indexOf('--hub');
    const body = i >= 0 && rest[i + 1] ? { hub: rest[i + 1] } : {};
    const r = await api('/api/setup-all', body);
    if (json) return console.log(JSON.stringify(r, null, 2));
    (r.steps || []).forEach((st) => line(st.ok, st.label, st.ok ? '' : (st.error || '')));
    return r.ok;
  },

  async skills() {
    const { skills } = await api('/api/skills');
    if (json) return console.log(JSON.stringify(skills, null, 2));
    skills.forEach((k) => line(k.enabled, `${k.id}`, k.description + (k.precondition_met === false ? ' (needs ' + (k.requires_tool || 'a tool') + ')' : '')));
  },

  async enable() { return toggle(true); },
  async disable() { return toggle(false); },

  async tools() {
    const { tools } = await api('/api/tools');
    if (json) return console.log(JSON.stringify(tools, null, 2));
    tools.forEach((t) => line(t.state === 'ready', `${t.id} (${t.kind})`, t.state === 'ready' ? t.name : t.why));
  },

  async install() {
    if (!rest.length) throw usage('install needs at least one tool id');
    let ok = true;
    for (const id of rest) {
      const r = await api('/api/tools/install', { id });
      line(r.ok, id, r.ok ? (r.detail || 'installed') : (r.error || 'failed') + (r.manual ? ' — run: ' + r.manual : ''));
      ok = ok && r.ok;
    }
    return ok;
  },

  async connect() {
    const id = rest[0];
    if (!id) throw usage('connect needs a tool id');
    const { tools } = await api('/api/tools');
    const t = tools.find((x) => x.id === id);
    if (!t) throw new Error('unknown tool: ' + id);
    if (HOST) {
      if (t.kind !== 'mcp') throw new Error(id + ' is installed, not connected: use `install ' + id + '`');
      const r = hostsMod.installHost(HOST, { mcp: [id], skills: false, hook: false, instructions: false });
      r.actions.forEach((a) => line(a.status !== 'error' && a.status !== 'skipped', id + ' (' + HOST + ')', a.status + (a.detail ? ': ' + a.detail : '')));
      return r.ok && r.actions.length > 0;
    }
    let secret;
    if (t.secret) secret = fromClipboard ? readClipboard() : await readHidden((t.secret.label || 'Key') + ' (typing is hidden): ');
    const r = await api('/api/tools/connect', { id, secret });
    line(r.ok, id, r.ok ? (r.detail || 'connected') : (r.error || 'failed'));
    return r.ok;
  },

  async obsidian() {
    if (!rest[0]) throw usage('obsidian needs a vault path');
    const r = await api('/api/config', { obsidian_vault: rest[0] });
    const ok = Boolean(r.vault_link && r.vault_link.linked);
    line(ok, 'Obsidian', ok ? 'linked' : 'could not link that folder');
    return ok;
  },
};

async function toggle(enabled) {
  if (!rest.length) throw usage((enabled ? 'enable' : 'disable') + ' needs at least one skill id');
  let ok = true;
  for (const id of rest) {
    try { const r = await api('/api/skills', { id, enabled }); line(r.ok, id, r.enabled ? 'on' : 'off'); ok = ok && r.ok; }
    catch (e) { line(false, id, e.message); ok = false; }
  }
  return ok;
}
function usage(msg) { const e = new Error(msg + '\n\n' + USAGE); e.usage = true; return e; }

// ---- run ------------------------------------------------------------------
if (!COMMANDS[cmd]) { console.error('unknown command: ' + cmd + '\n\n' + USAGE); process.exit(2); }
let code = 0;
try {
  srv = await startServer();
  keepAlive();
  const result = await COMMANDS[cmd]();
  if (result === false) code = 1;
} catch (e) {
  console.error('error: ' + e.message);
  code = e.usage ? 2 : 1;
} finally {
  clearInterval(beat);
  if (srv) srv.child.kill('SIGTERM');
}
process.exit(code);
