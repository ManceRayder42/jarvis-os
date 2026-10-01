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
//
// Exit code: 0 when the command did what it says, 1 when any part failed,
// 2 on bad usage.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const json = argv.includes('--json');
const rest = argv.slice(1).filter((a) => a !== '--json');
// Plan lines print an absolute command, so an agent (or a person) can run them
// from any directory without knowing where the plugin is installed.
const SELF = 'node "' + path.join(__dirname, 'agent.mjs') + '"';

const USAGE = `usage: node setup/agent.mjs <command>
  status | plan | skills | tools          read the checklist (add --json for machine output)
  setup [--hub <path>]                    create the memory, history, default skills, free tools
  enable <id>... | disable <id>...        switch skills
  install <id>...                         install programs from the Tools list
  connect <id>                            connect a connection (keys are typed by the person, never passed in)
  obsidian <vault-path>                   link the memory into an Obsidian vault`;

if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); process.exit(cmd ? 0 : 2); }

// ---- the server, as a child ------------------------------------------------
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
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
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('this needs a key typed by a person. Ask them to run this command themselves (in Claude Code: type ! followed by the command).'));
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
function buildPlan(s) {
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
  const tools = s.tools.filter((t) => t.state !== 'ready' && !bySetup(t));
  const order = (t) => (t.category === 'workspace' ? 0 : 1) + (t.default ? 0 : 2);
  tools.sort((a, b) => order(a) - order(b)).forEach((t) => {
    if (t.kind === 'mcp') {
      const keyed = Boolean(t.secret);
      steps.push({ step: t.category === 'workspace' ? 'workspace' : 'tools', id: t.id, recommended: !!t.default,
        who: keyed ? 'person' : 'agent', what: 'Connect ' + t.name,
        how: keyed ? '! ' + SELF + ' connect ' + t.id + '   (the person types this in Claude Code; it asks for ' + t.secret.label + ' with typing hidden)'
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

function line(ok, text, extra) { console.log((ok === true ? '✓ ' : ok === false ? '✗ ' : '· ') + text + (extra ? '  — ' + extra : '')); }

// ---- commands -------------------------------------------------------------
const COMMANDS = {
  async status() {
    const s = await snapshot();
    const plan = buildPlan(s);
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
    const plan = buildPlan(await snapshot());
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
    let secret;
    if (t.secret) secret = await readHidden((t.secret.label || 'Key') + ' (typing is hidden): ');
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
