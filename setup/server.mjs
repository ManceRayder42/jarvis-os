#!/usr/bin/env node
// jarvis-plugin setup server (SPEC.md decision 6).
//
// Ephemeral, loopback-only, zero dependencies. Serves the setup page,
// writes the hub config, and shuts itself down. Never forks, never
// detaches, never listens on anything but 127.0.0.1.
//
// Lifecycle: born from `/jarvis-setup`, gets a long grace period (180s) to
// receive its FIRST heartbeat -- that's the agent-to-human round trip
// (print URL, human switches app, opens browser), which routinely takes
// longer than a browser tab-close detection should. Once a heartbeat has
// landed, it tightens to the normal 15s idle timeout (tab closed). Dies
// after 10 minutes regardless, or when the terminal that spawned it is
// killed (SIGINT/SIGTERM/parent exit).

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HEARTBEAT_IDLE_MS = 15_000; // no heartbeat for this long -> exit, once one has arrived
const FIRST_HEARTBEAT_GRACE_MS = 180_000; // how long we wait for the FIRST heartbeat ever
const HEARTBEAT_CHECK_MS = 2_000; // how often we check for idleness
const HARD_CAP_MS = 10 * 60 * 1000; // exit after this, no matter what

const PLUGIN_ROOT = path.join(__dirname, '..');
const MEMORY_TEMPLATE_DIR = path.join(PLUGIN_ROOT, 'memory-template');

const DEFAULT_HUB = path.join(os.homedir(), 'jarvis-hub');
const DEFAULT_CONFIG = () => ({
  hub: DEFAULT_HUB,
  obsidian_vault: null,
  features: { core: true, research: true, media: false, telegram: false },
  remote: 'remote-control',
  auto_eli5: false,
});

// The per-skill install catalog -- one entry per skill the page can offer
// individually (replaces the old core/research/media category toggles).
// Loaded once at startup; every license/author/url claim in it was checked
// against a primary source (see the catalog file's own header comment and
// this repo's LICENSE-AUDIT.md).
const SKILLS_CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'skills-catalog.json'), 'utf8')).skills;

// Secrets this server is willing to write on the user's behalf. Anything
// else is rejected outright -- this is not a generic env-var writer.
//
// Derived from the catalog's `requires` fields rather than hardcoded, so a
// new skill that needs a new provider's key (Higgsfield today, something
// else tomorrow) needs a catalog entry, not a code change here.
//
// TELEGRAM_BOT_TOKEN is deliberately absent from every catalog entry (and
// so from this set): the real Telegram bridge is Anthropic's official
// `telegram` plugin, which reads its token from
// ~/.claude/channels/telegram/.env via `/telegram:configure`. A token
// written to <hub>/.env would just sit there unread -- worse, a second
// place holding the same token invites someone to run it from two configs
// at once, and Telegram's Bot API allows exactly one getUpdates consumer
// per token (see the Telegram section of setup/page.html).
//
// Purely derived: a key is accepted only because some skill in the catalog says
// it needs one. Adding a skill with a new provider therefore needs no code
// change here, and a key with no skill behind it can never be collected.
const ALLOWED_SECRETS = new Set(SKILLS_CATALOG.flatMap((s) => s.requires || []));

const TOKEN = crypto.randomBytes(24).toString('hex');
const PAGE_TEMPLATE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');

let hubDir = DEFAULT_HUB;
let config = loadConfig(hubDir);
let lastHeartbeat = Date.now();
let heartbeatReceived = false; // false until the first /api/heartbeat lands
let port; // assigned once the server is actually listening

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadConfig(hub) {
  const file = path.join(hub, 'jarvis-config.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG(),
      ...parsed,
      hub,
      features: { ...DEFAULT_CONFIG().features, ...(parsed.features || {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG(), hub };
  }
}

function writeConfig() {
  fs.mkdirSync(config.hub, { recursive: true });
  const file = path.join(config.hub, 'jarvis-config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

// The SessionStart hook (hooks/session-start.mjs) has no access to this
// server's config -- it finds the hub by reading this pointer file from the
// real user HOME. Without it the hook says "Not set up yet" forever, even
// after a successful /api/config save. Write-then-rename so a crash mid-write
// can't leave a truncated pointer behind.
function writeHubPointer(hub) {
  const pointerPath = path.join(os.homedir(), '.jarvis-hub-path');
  try {
    const tmp = `${pointerPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, hub + '\n');
    fs.renameSync(tmp, pointerPath);
    return { ok: true, path: pointerPath };
  } catch (e) {
    return { ok: false, path: pointerPath, error: e.message };
  }
}

// A freshly created hub has no MEMORY.md, so the hook stays silently quiet
// with no clue why. Seed it from the plugin's memory-template/ the first
// time this hub is used -- but never touch a file that's already there, so
// re-saving config from Setup can't clobber a user's real memory.
function seedHub(hub) {
  const memoryPath = path.join(hub, 'MEMORY.md');
  if (fs.existsSync(memoryPath)) {
    return { seeded: false, reason: 'already-populated' };
  }
  try {
    fs.mkdirSync(hub, { recursive: true });
    const entries = fs.readdirSync(MEMORY_TEMPLATE_DIR);
    const written = [];
    for (const entry of entries) {
      const src = path.join(MEMORY_TEMPLATE_DIR, entry);
      const dest = path.join(hub, entry);
      if (!fs.statSync(src).isFile()) continue;
      if (fs.existsSync(dest)) continue; // never overwrite
      fs.copyFileSync(src, dest);
      written.push(entry);
    }
    return { seeded: true, reason: 'created', files: written };
  } catch (e) {
    return { seeded: false, reason: 'error', error: e.message };
  }
}

// Constant-time token compare that doesn't leak length via early exit --
// hash both sides to a fixed 32 bytes first, then timingSafeEqual.
function tokenMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function isTrustedOrigin(req) {
  const expectedHost = `127.0.0.1:${port}`;
  if (req.headers.host !== expectedHost) return false;
  const origin = req.headers.origin;
  // Origin isn't sent on plain GET navigations; when it IS sent (fetch/XHR,
  // especially POST) it must match exactly.
  if (origin !== undefined && origin !== `http://${expectedHost}`) return false;
  return true;
}

function extractToken(req, url) {
  const header = req.headers['x-jarvis-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  return url.searchParams.get('t') || '';
}

function reject403(res) {
  res.writeHead(403);
  res.end();
}

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveIndex(res) {
  const html = PAGE_TEMPLATE.replace('__JARVIS_TOKEN__', TOKEN);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function serveState(res) {
  sendJSON(res, 200, config);
}

async function handleConfig(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJSON(res, 400, { ok: false, error: 'invalid JSON' });
  }

  if (typeof body.hub === 'string' && body.hub.trim()) {
    config.hub = expandHome(body.hub.trim());
  }
  if (Object.prototype.hasOwnProperty.call(body, 'obsidian_vault')) {
    const v = body.obsidian_vault;
    config.obsidian_vault = v && String(v).trim() ? expandHome(String(v).trim()) : null;
  }
  if (body.features && typeof body.features === 'object') {
    for (const key of ['core', 'research', 'media', 'telegram']) {
      if (key in body.features) config.features[key] = Boolean(body.features[key]);
    }
  }
  if (typeof body.remote === 'string' && body.remote.trim()) {
    config.remote = body.remote.trim();
  }
  if (Object.prototype.hasOwnProperty.call(body, 'auto_eli5')) {
    config.auto_eli5 = Boolean(body.auto_eli5);
  }

  try {
    writeConfig();
  } catch {
    return sendJSON(res, 500, { ok: false, error: 'failed to write config' });
  }

  // All four are idempotent and cheap, so just run them on every save
  // rather than trying to detect "did the hub/vault/flag actually change"
  // -- that also keeps the pointer, symlink and rule file self-healing if
  // any of them are ever deleted out from under the hub. seedHub must run
  // before applyAutoEli5 -- the latter edits MEMORY.md, which seedHub is
  // what creates on a fresh hub.
  const hubPointer = writeHubPointer(config.hub);
  const seed = seedHub(config.hub);
  const vaultLink = config.obsidian_vault ? linkVaultToHub(config.obsidian_vault, config.hub) : null;
  const autoEli5 = applyAutoEli5(config.hub, config.auto_eli5);

  sendJSON(res, 200, { ok: true, config, hub_pointer: hubPointer, seed, vault_link: vaultLink, auto_eli5: autoEli5 });
}

function handleHeartbeat(req, res) {
  lastHeartbeat = Date.now();
  heartbeatReceived = true;
  sendJSON(res, 200, { ok: true });
}

// obsidian_vault was collected and written to jarvis-config.json but read by
// nothing -- the promise that notes reach the vault was unimplemented.
// Symlinking <vault>/Jarvis -> <hub> makes it literally true: anything
// written under the hub shows up inside Obsidian for free, no separate
// sync logic. Safe to call on every config save (the caller does) because
// re-linking an already-correct symlink is a no-op, and anything already
// occupying that path is left alone rather than overwritten.
function linkVaultToHub(vault, hub) {
  let stat;
  try {
    stat = fs.statSync(vault);
  } catch {
    return { linked: false, reason: 'vault-not-found', path: vault };
  }
  if (!stat.isDirectory()) {
    return { linked: false, reason: 'vault-not-a-directory', path: vault };
  }

  const linkPath = path.join(vault, 'Jarvis');
  try {
    const existing = fs.lstatSync(linkPath);
    if (existing.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
      if (resolved === path.resolve(hub)) {
        return { linked: true, reason: 'already-linked', path: linkPath };
      }
      // Points somewhere else -- could be a previous hub. Report it, don't touch it.
      return { linked: false, reason: 'symlink-points-elsewhere', path: linkPath, target: resolved };
    }
    return { linked: false, reason: 'path-in-use', path: linkPath };
  } catch {
    // ENOENT from lstatSync -- nothing there, safe to create.
  }

  try {
    fs.symlinkSync(hub, linkPath, 'dir');
    return { linked: true, reason: 'created', path: linkPath };
  } catch (e) {
    return { linked: false, reason: 'error', path: linkPath, error: e.message };
  }
}

// Shared by the 'obsidian' preflight row and the Obsidian skills' catalog
// precondition (`detect: "obsidian"`) -- one detector, two consumers. Only
// checks for the app itself; a configured obsidian_vault (which implies the
// user has Obsidian, even if the app lives somewhere this doesn't check)
// counts too.
function detectObsidian() {
  const appCandidates = IS_WIN
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'Obsidian', 'Obsidian.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Obsidian', 'Obsidian.exe'),
      ]
    : IS_MAC
      ? ['/Applications/Obsidian.app', path.join(os.homedir(), 'Applications', 'Obsidian.app')]
      : [
          '/usr/bin/obsidian', '/usr/local/bin/obsidian', '/snap/bin/obsidian',
          '/var/lib/flatpak/exports/bin/md.obsidian.Obsidian',
          path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'bin', 'md.obsidian.Obsidian'),
        ];
  const appPath = appCandidates.find((p) => fs.existsSync(p)) || null;
  const vaultPath = config.obsidian_vault || null;
  return { present: Boolean(appPath || vaultPath), app_path: appPath, vault_path: vaultPath };
}

// auto_eli5 is the same defect class as obsidian_vault: a setting the page
// collects but that nothing reads is worse than no setting -- it looks
// configured while doing nothing. Turning it on writes a rule file the
// `done`/session-start machinery doesn't need to know about specifically,
// because MEMORY.md itself is what the SessionStart hook injects into every
// session -- a pointer line there is enough to surface it without touching
// the hook at all.
const AUTO_ELI5_RULE_RELPATH = path.join('rules', 'auto-eli5.md');
const AUTO_ELI5_INDEX_LINE = '- [Auto-ELI5](rules/auto-eli5.md) — long explanations render as a visual ELI5 HTML artifact instead of a wall of text.';

function autoEli5RuleContent() {
  return `---
name: auto-eli5
description: Render long explanations as a visual ELI5 HTML artifact instead of a wall of text
metadata:
  type: feedback
---

When about to explain a concept, how something works, an architecture, or a
codebase structure in more than a couple of sentences, render it as a
visual, ELI5-style HTML artifact instead of a wall of markdown text -- big
pictures, few words.

Skip this for one-liners, yes/no answers, and short status updates -- those
stay in chat.

**Why:** a long explanation in chat gets skimmed or ignored; a visual
artifact actually gets looked at.

**How to apply:** before writing more than a couple of sentences of
explanation, build the HTML artifact instead of the prose.

This file was created by the "Auto-ELI5" toggle in Jarvis OS setup. Turning
it off removes this file and its line in MEMORY.md; turning it back on
recreates it from scratch, so keep a copy of any edits you want to preserve.
`;
}

// Adds or removes one exact line from MEMORY.md's "## Feedback" section.
// Never touches anything else in the file -- if the section heading isn't
// there (a heavily customized MEMORY.md, or no hub yet), this fails softly
// and reports why rather than guessing where to put the line.
function setMemoryIndexLine(hub, line, present) {
  const memoryPath = path.join(hub, 'MEMORY.md');
  let content;
  try {
    content = fs.readFileSync(memoryPath, 'utf8');
  } catch {
    return { ok: false, reason: 'no-memory-file' };
  }

  const lines = content.split('\n');
  const hasLine = lines.includes(line);
  if (present === hasLine) {
    return { ok: true, reason: present ? 'already-present' : 'already-absent' };
  }

  if (present) {
    const feedbackIdx = lines.findIndex((l) => l.trim() === '## Feedback');
    if (feedbackIdx === -1) return { ok: false, reason: 'no-feedback-section' };
    lines.splice(feedbackIdx + 1, 0, line);
  } else {
    lines.splice(lines.indexOf(line), 1);
  }

  try {
    fs.writeFileSync(memoryPath, lines.join('\n'));
    return { ok: true, reason: present ? 'added' : 'removed' };
  } catch (e) {
    return { ok: false, reason: 'write-error', error: e.message };
  }
}

function applyAutoEli5(hub, enabled) {
  const rulePath = path.join(hub, AUTO_ELI5_RULE_RELPATH);
  let fileResult;

  if (enabled) {
    try {
      fs.mkdirSync(path.dirname(rulePath), { recursive: true });
      if (fs.existsSync(rulePath)) {
        fileResult = { action: 'already-present' };
      } else {
        fs.writeFileSync(rulePath, autoEli5RuleContent());
        fileResult = { action: 'created' };
      }
    } catch (e) {
      fileResult = { action: 'error', error: e.message };
    }
  } else {
    try {
      if (fs.existsSync(rulePath)) {
        fs.unlinkSync(rulePath);
        fileResult = { action: 'removed' };
      } else {
        fileResult = { action: 'already-absent' };
      }
    } catch (e) {
      fileResult = { action: 'error', error: e.message };
    }
  }

  const memoryIndex = setMemoryIndexLine(hub, AUTO_ELI5_INDEX_LINE, enabled);
  const ok = fileResult.action !== 'error' && memoryIndex.ok !== false;
  return { enabled, ok, rule_path: rulePath, rule_file: fileResult, memory_index: memoryIndex };
}

// Best-effort environment checks, run once at startup and served to the
// page over /api/preflight (reusing the request handler's existing
// Origin/Host + token gate rather than standing up a second auth path).
// Nothing here is fatal -- a missing tool is reported with the exact
// install/fix line, never blocks the setup flow.
function runCommand(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output: out.trim() };
  } catch (e) {
    // Capture stderr too (not just e.message) -- the /api/git-init and
    // /api/telegram-install endpoints need the actual CLI error text to
    // show the user something more useful than "exited with code 1".
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    return { ok: false, output: stderr, error: e.message };
  }
}

// Not a Mac-only plugin. Everything below picks the right command for the
// platform it is actually running on, and says so plainly when a thing simply
// cannot be installed automatically here.
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

function hasCommand(cmd) {
  const probe = IS_WIN ? runCommand('where', [cmd]) : runCommand('which', [cmd]);
  return Boolean(probe.ok && probe.output);
}

// One package, spelled the way each platform's usual manager spells it.
const PACKAGES = {
  git:      { brew: ['install', 'git'],                   apt: 'git',    dnf: 'git',    winget: 'Git.Git',            url: 'https://git-scm.com/downloads' },
  bun:      { brew: ['install', 'oven-sh/bun/bun'],       apt: null,     dnf: null,     winget: 'Oven-sh.Bun',        url: 'https://bun.sh' },
  tmux:     { brew: ['install', 'tmux'],                  apt: 'tmux',   dnf: 'tmux',   winget: null,                 url: 'https://github.com/tmux/tmux/wiki/Installing' },
  ffmpeg:   { brew: ['install', 'ffmpeg'],                apt: 'ffmpeg', dnf: 'ffmpeg', winget: 'Gyan.FFmpeg',        url: 'https://ffmpeg.org/download.html' },
  obsidian: { brew: ['install', '--cask', 'obsidian'],    apt: null,     dnf: null,     winget: 'Obsidian.Obsidian',  url: 'https://obsidian.md/download' },
};

// The line to show someone when we cannot run the install for them.
function manualInstall(tool) {
  const pkg = PACKAGES[tool];
  if (!pkg) return null;
  if (IS_MAC) return 'brew ' + pkg.brew.join(' ');
  if (IS_WIN) return pkg.winget ? 'winget install ' + pkg.winget : ('download it from ' + pkg.url);
  if (pkg.apt) return 'sudo apt install ' + pkg.apt + '   (or: sudo dnf install ' + pkg.dnf + ')';
  return 'see ' + pkg.url;
}

function parseSemver(text) {
  const m = typeof text === 'string' ? text.match(/(\d+)\.(\d+)\.(\d+)/) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionAtLeast(version, min) {
  if (!version) return false;
  for (let i = 0; i < min.length; i++) {
    if (version[i] > min[i]) return true;
    if (version[i] < min[i]) return false;
  }
  return true;
}

const MIN_CLAUDE_VERSION = [2, 1, 200]; // channels + auto permission mode need this or newer

function runPreflight() {
  const checks = [];

  // Node is already running us -- just report what we're executing under.
  checks.push({ id: 'node', label: 'Node.js', required: true, ok: true, detail: process.version });

  const git = runCommand('git', ['--version']);
  if (!git.ok) {
    // git is NOT required. The memory is a folder of plain text files and works
    // without it; git only adds a history, and only the `done` skill uses it.
    // Marking it required would fail setup on a machine that never needed it.
    checks.push({
      id: 'git', label: 'git', required: false, ok: false,
      detail: 'not installed -- memory still works, you just get no history',
      fix: manualInstall('git'),
    });
  } else {
    checks.push({ id: 'git', label: 'git', required: false, ok: true, detail: git.output });

    // The `done` skill commits the hub -- without a configured identity
    // that fails with git's confusing "Please tell me who you are" error.
    const name = runCommand('git', ['config', 'user.name']);
    const email = runCommand('git', ['config', 'user.email']);
    const missing = [];
    if (!name.ok || !name.output) missing.push('user.name');
    if (!email.ok || !email.output) missing.push('user.email');
    if (missing.length) {
      const fixes = [];
      if (missing.includes('user.name')) fixes.push('git config --global user.name "Your Name"');
      if (missing.includes('user.email')) fixes.push('git config --global user.email "you@example.com"');
      // Not "required" any more: setup sets a repo-local author on the hub
      // itself when the machine has no global one, so this can never block a
      // person who has never configured git. Still reported, because someone
      // who DOES care wants to see which name their saved changes carry.
      checks.push({
        id: 'git-identity', label: 'git identity', required: false, ok: false,
        detail: 'not set on this machine -- setup will use a local name for the memory folder',
        fix: fixes.join(' && '),
      });
    } else {
      checks.push({ id: 'git-identity', label: 'git identity', required: false, ok: true, detail: name.output + ' <' + email.output + '>' });
    }
  }

  const claude = runCommand('claude', ['--version']);
  if (!claude.ok) {
    checks.push({ id: 'claude', label: 'claude CLI', required: true, ok: false, detail: 'not found', fix: 'see https://claude.com/claude-code' });
  } else {
    const v = parseSemver(claude.output);
    const meetsMin = versionAtLeast(v, MIN_CLAUDE_VERSION);
    checks.push({
      id: 'claude', label: 'claude CLI', required: true, ok: meetsMin,
      detail: claude.output + (meetsMin ? '' : ' -- need >= 2.1.200 for channels + auto permission mode'),
      fix: meetsMin ? undefined : 'update Claude Code (see https://claude.com/claude-code)',
    });
  }

  // Optional: reported so the user knows what they're missing, never blocking.
  const bun = runCommand('bun', ['--version']);
  checks.push({
    id: 'bun', label: 'bun', required: false, ok: bun.ok,
    detail: bun.ok ? bun.output : 'not found -- the official Telegram plugin\'s MCP runs on it',
    fix: bun.ok ? undefined : manualInstall('bun'),
  });

  const tmux = runCommand('tmux', ['-V']);
  checks.push({
    id: 'tmux', label: 'tmux', required: false, ok: tmux.ok,
    detail: tmux.ok ? tmux.output : 'not found',
    fix: tmux.ok ? undefined : manualInstall('tmux'),
  });

  const ffmpeg = runCommand('ffmpeg', ['-version']);
  checks.push({
    id: 'ffmpeg', label: 'ffmpeg', required: false, ok: ffmpeg.ok,
    detail: ffmpeg.ok ? ffmpeg.output.split('\n')[0] : 'not found -- needed for voice scripts',
    fix: ffmpeg.ok ? undefined : manualInstall('ffmpeg'),
  });

  // Not a CLI tool -- detected by app-bundle presence (or a configured
  // vault). Optional: only the Obsidian-flavored skills care.
  const obsidian = detectObsidian();
  checks.push({
    id: 'obsidian', label: 'Obsidian', required: false, ok: obsidian.present,
    detail: obsidian.app_path || (obsidian.vault_path ? 'not found as an app, but a vault path is configured' : 'not found'),
    fix: obsidian.present ? undefined : manualInstall('obsidian'),
  });

  return checks;
}

function writeSecretToEnvFile(hub, name, value) {
  fs.mkdirSync(hub, { recursive: true });

  const envPath = path.join(hub, '.env');
  let lines = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf8').split('\n').filter(Boolean);
  }
  const filtered = lines.filter((l) => !l.startsWith(`${name}=`));
  filtered.push(`${name}=${value}`);
  fs.writeFileSync(envPath, filtered.join('\n') + '\n', { mode: 0o600 });

  // Belt-and-suspenders: if the hub ever becomes a git repo, .env never
  // gets committed from under the user.
  const gitignorePath = path.join(hub, '.gitignore');
  let existing = '';
  if (fs.existsSync(gitignorePath)) existing = fs.readFileSync(gitignorePath, 'utf8');
  if (!existing.split('\n').includes('.env')) {
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(gitignorePath, existing + sep + '.env\n');
  }
}

async function handleSecret(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJSON(res, 400, { ok: false, error: 'invalid JSON' });
  }

  const name = typeof body.name === 'string' ? body.name : '';
  const value = typeof body.value === 'string' ? body.value : '';

  // Never let a request body reach a log line, an error message, or a
  // stack trace below this point.
  if (!ALLOWED_SECRETS.has(name) || value.length === 0) {
    return sendJSON(res, 400, { ok: false, error: 'unsupported secret name or empty value' });
  }

  try {
    writeSecretToEnvFile(config.hub, name, value);
  } catch {
    return sendJSON(res, 500, { ok: false, error: 'failed to save secret' });
  }

  const masked = value.length > 4 ? '•'.repeat(value.length - 4) + value.slice(-4) : value;
  sendJSON(res, 200, { ok: true, masked });
}

// POST /api/git-init -- the `done` skill commits the hub, which fails
// outright if the hub isn't a git repo yet. This does that one step for the
// user.
//
// Identity: a global identity, if the user already has one, is used and left
// alone. If they have none, we set one ON THIS REPOSITORY ONLY. That is a
// deliberate reversal of the earlier "advisory, never automatic" line, and the
// reason is the audience: someone who has never heard of git cannot be asked to
// run `git config --global`, and until they do, every single `/done` fails.
// The hub is a private local repository whose commits are never pushed
// anywhere, so a placeholder author on it costs nothing and unblocks everything.
// We never touch the user's global config.
async function handleGitInit(req, res) {
  try {
    fs.mkdirSync(config.hub, { recursive: true });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'failed to create hub directory: ' + e.message });
  }

  const alreadyRepo = fs.existsSync(path.join(config.hub, '.git'));
  if (!alreadyRepo) {
    const init = runCommand('git', ['-C', config.hub, 'init']);
    if (!init.ok) {
      return sendJSON(res, 500, { ok: false, error: 'git init failed', detail: init.output || init.error });
    }
  }

  const readIdentity = () => {
    const name = runCommand('git', ['-C', config.hub, 'config', 'user.name']);
    const email = runCommand('git', ['-C', config.hub, 'config', 'user.email']);
    return {
      ok: Boolean(name.ok && name.output && email.ok && email.output),
      name: name.output,
      email: email.output,
    };
  };

  let identity = readIdentity();
  let identitySetHere = false;
  if (!identity.ok) {
    // Repo-local only -- no --global anywhere in this call.
    runCommand('git', ['-C', config.hub, 'config', 'user.name', 'Jarvis OS']);
    runCommand('git', ['-C', config.hub, 'config', 'user.email', 'jarvis-os@localhost']);
    identity = readIdentity();
    identitySetHere = identity.ok;
  }

  sendJSON(res, 200, {
    ok: true,
    already_repo: alreadyRepo,
    created: !alreadyRepo,
    identity_ok: identity.ok,
    identity_set_here: identitySetHere,
    identity: identity.ok ? { name: identity.name, email: identity.email } : null,
    error: identity.ok ? undefined : 'could not set an author for this folder',
  });
}

// POST /api/telegram-install -- runs the two `claude plugin` commands the
// user would otherwise type by hand. Idempotent: if the CLI's own output
// says "already installed"/"already added", that's treated as success
// rather than failure, since a non-zero exit on a repeat run is the more
// likely behavior than a clean no-op.
function looksAlreadyDone(text) {
  return /already (installed|added|exists|present)/i.test(text || '');
}

async function handleTelegramInstall(req, res) {
  const marketplace = runCommand('claude', ['plugin', 'marketplace', 'add', 'anthropics/claude-plugins-official']);
  const marketplaceOk = marketplace.ok || looksAlreadyDone(marketplace.output);

  const install = runCommand('claude', ['plugin', 'install', 'telegram@claude-plugins-official']);
  const installOk = install.ok || looksAlreadyDone(install.output);

  const ok = marketplaceOk && installOk;
  sendJSON(res, ok ? 200 : 500, {
    ok,
    marketplace: {
      ok: marketplaceOk,
      already: !marketplace.ok && looksAlreadyDone(marketplace.output),
      detail: marketplace.output || marketplace.error,
    },
    install: {
      ok: installOk,
      already: !install.ok && looksAlreadyDone(install.output),
      detail: install.output || install.error,
    },
  });
}

// GET /api/telegram-status -- read-only, so the page can show "send your
// bot any message, then click Pair" without the user ever touching a
// terminal. This never writes access.json -- /telegram:configure and
// /telegram:access own that file exclusively. Schema is the official
// plugin's own (telegram@claude-plugins-official, server.ts's `Access` /
// `PendingEntry` types): { dmPolicy, allowFrom: string[], groups,
// pending: Record<code, {senderId, chatId, createdAt, expiresAt, replies}> }.
const TELEGRAM_ACCESS_PATH = path.join(os.homedir(), '.claude', 'channels', 'telegram', 'access.json');

function handleTelegramStatus(req, res) {
  let access;
  try {
    access = JSON.parse(fs.readFileSync(TELEGRAM_ACCESS_PATH, 'utf8'));
  } catch {
    // Missing file means the official plugin's channel server has never run
    // yet (not installed, or installed but never started) -- not an error.
    return sendJSON(res, 200, { ok: true, configured: false, policy: null, allow_count: 0, pending: [] });
  }

  const now = Date.now();
  const pending = Object.entries(access.pending || {})
    .map(([code, p]) => ({ code, sender_id: p.senderId, created_at: p.createdAt, expires_at: p.expiresAt }))
    .filter((p) => typeof p.expires_at !== 'number' || p.expires_at > now);

  sendJSON(res, 200, {
    ok: true,
    configured: true,
    policy: access.dmPolicy || null,
    allow_count: Array.isArray(access.allowFrom) ? access.allowFrom.length : 0,
    pending,
  });
}

// --- Skill materialization boundary -------------------------------------
// Moving a skill's directory between optional-skills/ and skills/ (so
// Claude Code actually loads/unloads it -- a config flag alone would be
// another inert setting, the same defect class obsidian_vault had before
// this file's earlier pass) is a separate piece of work. This server calls
// into it rather than keeping a second copy of that logic.
//
// Contract expected -- as of writing this, NOT YET present anywhere in the
// repo (checked: no optional-skills/ directory, no function or file
// matching materializ/enableSkill/toggleSkill/moveSkill in the tree):
//
//   file:    setup/skills-materializer.mjs
//   export:  async function setSkillEnabled(pluginRoot, skillId, enabled)
//   returns: { ok: boolean,
//              action: 'enabled' | 'disabled' | 'already-enabled'
//                     | 'already-disabled' | 'not-found' | 'error',
//              error?: string }
//   behavior:
//     - enabled:true  moves <pluginRoot>/optional-skills/<skillId> to
//       <pluginRoot>/skills/<skillId>; if it's already under skills/,
//       no-op with action:'already-enabled'.
//     - enabled:false does the reverse; already under optional-skills/ ->
//       no-op with action:'already-disabled'.
//     - skillId missing from BOTH directories -> { ok:false, action:'not-found' }.
//     - never throws -- catches its own fs errors into { ok:false, action:'error', error }.
//
// Until that file exists, POST /api/skills reports 501 honestly instead of
// silently no-op'ing or reimplementing the same fs.rename here.
async function materializeSkill(skillId, enabled) {
  let mod;
  try {
    mod = await import('./skills-materializer.mjs');
  } catch {
    return { ok: false, action: 'not-implemented', error: 'skills materializer not built yet -- see the contract comment above materializeSkill() in setup/server.mjs' };
  }
  try {
    return await mod.setSkillEnabled(PLUGIN_ROOT, skillId, enabled);
  } catch (e) {
    return { ok: false, action: 'error', error: e.message };
  }
}

// GET /api/skills -- the catalog plus live state: whether each skill is
// currently materialized into skills/ (installed) and, where the catalog
// declares a `detect` key, whether its precondition currently holds.
function handleSkillsList(req, res) {
  const skills = SKILLS_CATALOG.map((s) => {
    const enabled = fs.existsSync(path.join(PLUGIN_ROOT, 'skills', s.id));
    const preconditionMet = s.detect === 'obsidian' ? detectObsidian().present : null;
    return { ...s, enabled, precondition_met: preconditionMet };
  });
  sendJSON(res, 200, { ok: true, skills });
}

// POST /api/skills {id, enabled} -- toggle one skill. See the materializer
// contract above for what actually moves the directory.
async function handleSkillsSet(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJSON(res, 400, { ok: false, error: 'invalid JSON' });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  const enabled = Boolean(body.enabled);
  const entry = SKILLS_CATALOG.find((s) => s.id === id);
  if (!entry) {
    return sendJSON(res, 400, { ok: false, error: 'unknown skill id: ' + id });
  }

  const result = await materializeSkill(id, enabled);
  const status = result.ok ? 200 : result.action === 'not-implemented' ? 501 : 500;
  sendJSON(res, status, { ok: result.ok, id, enabled, action: result.action, error: result.error });
}

let PREFLIGHT = runPreflight();

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${port}`);
  } catch {
    return reject403(res);
  }

  if (!isTrustedOrigin(req)) return reject403(res);
  if (!tokenMatches(extractToken(req, url))) return reject403(res);

  try {
    if (req.method === 'GET' && url.pathname === '/') return serveIndex(res);
    if (req.method === 'GET' && url.pathname === '/api/state') return serveState(res);
    if (req.method === 'GET' && url.pathname === '/api/preflight') {
      // ?refresh=1 re-runs every check live (a few subprocess spawns, tens
      // of ms) instead of returning the snapshot taken at server startup --
      // for a "Recheck" button after the user just ran a fix in another
      // terminal. Plain GET stays cheap and returns the cached snapshot.
      const checks = url.searchParams.get('refresh') ? runPreflight() : PREFLIGHT;
      return sendJSON(res, 200, { checks });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') return await handleConfig(req, res);
    if (req.method === 'POST' && url.pathname === '/api/heartbeat') return handleHeartbeat(req, res);
    if (req.method === 'POST' && url.pathname === '/api/secret') return await handleSecret(req, res);
    if (req.method === 'POST' && url.pathname === '/api/git-init') return await handleGitInit(req, res);
    if (req.method === 'POST' && url.pathname === '/api/telegram-install') return await handleTelegramInstall(req, res);
    if (req.method === 'GET' && url.pathname === '/api/telegram-status') return handleTelegramStatus(req, res);
    if (req.method === 'GET' && url.pathname === '/api/skills') return handleSkillsList(req, res);
    if (req.method === 'POST' && url.pathname === '/api/skills') return await handleSkillsSet(req, res);
    if (req.method === 'POST' && url.pathname === '/api/setup-all') return await handleSetupAll(req, res);
    if (req.method === 'POST' && url.pathname === '/api/install-tool') return await handleInstallTool(req, res);
    if (req.method === 'POST' && url.pathname === '/api/telegram-token') return await handleTelegramToken(req, res);
  } catch {
    return sendJSON(res, 500, { ok: false, error: 'internal error' });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

let shuttingDown = false;
// ---------------------------------------------------------------------------
// Automation. The audience for this page includes people who have never heard
// of git, and the honest way to serve them is to do the work rather than to
// explain it well. Everything below is something a person would otherwise have
// had to do by hand in a terminal.
// ---------------------------------------------------------------------------

// POST /api/setup-all -- the whole install behind one press. Every step is
// individually idempotent, and one failing step never aborts the rest: the
// caller gets a per-step result so the page can show exactly what did and did
// not happen, instead of a single unhelpful false.
async function handleSetupAll(req, res) {
  let body = {};
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch { /* an empty body is the normal case -- use the defaults */ }

  if (typeof body.hub === 'string' && body.hub.trim()) config.hub = expandHome(body.hub.trim());

  const steps = [];
  const step = (id, label, fn) => {
    try {
      const detail = fn();
      steps.push({ id, label, ok: true, detail: detail === undefined ? null : detail });
    } catch (e) {
      steps.push({ id, label, ok: false, error: e.message });
    }
  };

  step('folder', 'Making a place for its memory', () => {
    fs.mkdirSync(config.hub, { recursive: true });
    writeConfig();
    const pointer = writeHubPointer(config.hub);
    const seed = seedHub(config.hub);
    return { hub: config.hub, pointer, seed };
  });

  step('history', 'Turning on its history', () => {
    // Best effort by design: without git the memory is still a folder of text
    // files that works exactly the same, so a machine with no git gets a note,
    // not a failed step.
    if (!hasCommand('git')) return { skipped: true, reason: 'git not installed' };
    const alreadyRepo = fs.existsSync(path.join(config.hub, '.git'));
    if (!alreadyRepo) {
      const init = runCommand('git', ['-C', config.hub, 'init']);
      if (!init.ok) return { skipped: true, reason: init.output || 'git init failed' };
    }
    const has = (k) => {
      const r = runCommand('git', ['-C', config.hub, 'config', k]);
      return Boolean(r.ok && r.output);
    };
    // Repo-local only. See handleGitInit for why this is set rather than asked.
    if (!has('user.name')) runCommand('git', ['-C', config.hub, 'config', 'user.name', 'Jarvis OS']);
    if (!has('user.email')) runCommand('git', ['-C', config.hub, 'config', 'user.email', 'jarvis-os@localhost']);
    return { created: !alreadyRepo };
  });

  // Obsidian, if it is there. Silence is the right outcome when it is not --
  // this is an extra, and a person who does not use Obsidian should never see
  // it presented as something that failed.
  step('notes', 'Looking for Obsidian', () => {
    const obs = detectObsidian();
    if (!obs || !obs.present) return { found: false };
    if (!config.obsidian_vault) return { found: true, linked: false, reason: 'no-vault-chosen' };
    const link = linkVaultToHub(config.obsidian_vault, config.hub);
    return { found: true, ...link };
  });

  const enabled = [];
  const failed = [];
  for (const skill of SKILLS_CATALOG.filter((sk) => sk.default)) {
    const dir = path.join(PLUGIN_ROOT, 'skills', skill.id);
    if (fs.existsSync(dir)) { enabled.push(skill.id); continue; }
    try {
      const r = await materializeSkill(skill.id, true);
      (r && r.ok ? enabled : failed).push(skill.id);
    } catch { failed.push(skill.id); }
  }
  steps.push({
    id: 'skills',
    label: 'Switching on the basics',
    ok: failed.length === 0,
    detail: { enabled, failed },
  });

  step('checkup', 'Checking your Mac', () => {
    PREFLIGHT = runPreflight();
    const blocking = PREFLIGHT.filter((c) => c.required && !c.ok);
    if (blocking.length) throw new Error(blocking.map((c) => c.label).join(', ') + ' needs attention');
    return { checks: PREFLIGHT.length };
  });

  sendJSON(res, 200, { ok: steps.every((st) => st.ok), steps, config });
}

// POST /api/install-tool { tool } -- installs one known optional tool through
// Homebrew, and only on an explicit request. The allowlist is the whole safety
// model: nothing here takes a package name from the caller.
const INSTALLABLE = Object.keys(PACKAGES).filter((k) => k !== 'git');

async function handleInstallTool(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJSON(res, 400, { ok: false, error: 'invalid JSON' });
  }
  const tool = String(body.tool || '');
  if (!INSTALLABLE.includes(tool)) {
    return sendJSON(res, 400, { ok: false, error: 'unknown tool: ' + tool });
  }
  const pkg = PACKAGES[tool];

  // Pick the manager this machine actually has. Anything that needs a password
  // (apt, dnf) is never run from here -- a web page silently invoking sudo is
  // not something a user can consent to, so those become a copyable line.
  let cmd = null;
  let args = null;
  if (IS_MAC && hasCommand('brew')) { cmd = 'brew'; args = pkg.brew; }
  else if (IS_WIN && pkg.winget && hasCommand('winget')) { cmd = 'winget'; args = ['install', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--id', pkg.winget]; }

  if (!cmd) {
    return sendJSON(res, 200, {
      ok: false,
      error: 'no-installer',
      manual: manualInstall(tool),
      url: pkg.url,
    });
  }

  const r = runCommand(cmd, args);
  PREFLIGHT = runPreflight();
  sendJSON(res, 200, { ok: r.ok, tool, via: cmd, detail: (r.output || r.error || '').slice(-2000) });
}

// POST /api/telegram-token { value } -- writes the bot token where the official
// Telegram plugin reads it.
//
// This is deliberate, and it reverses an earlier decision in this file. The
// documented path is `/telegram:configure` inside a Claude session, which is
// fine for a developer and a wall for everyone else. The token is one line in
// one file; asking someone to open a terminal to place it there is not caution,
// it is just a worse product. Pairing still belongs to `/telegram:access`, and
// this never touches access.json.
const TELEGRAM_ENV_PATH = path.join(os.homedir(), '.claude', 'channels', 'telegram', '.env');

async function handleTelegramToken(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJSON(res, 400, { ok: false, error: 'invalid JSON' });
  }
  const value = String(body.value || '').trim();
  // BotFather tokens look like 123456789:AA... -- check the shape so a
  // mistyped paste fails here rather than silently later.
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(value)) {
    return sendJSON(res, 400, { ok: false, error: 'that does not look like a bot token' });
  }

  try {
    fs.mkdirSync(path.dirname(TELEGRAM_ENV_PATH), { recursive: true });
    let lines = [];
    if (fs.existsSync(TELEGRAM_ENV_PATH)) {
      // Preserve anything else already in the file; only this key is ours.
      lines = fs.readFileSync(TELEGRAM_ENV_PATH, 'utf8').split('\n')
        .filter((l) => !/^TELEGRAM_BOT_TOKEN=/.test(l));
    }
    lines = lines.filter((l) => l.trim() !== '');
    lines.push('TELEGRAM_BOT_TOKEN=' + value);
    fs.writeFileSync(TELEGRAM_ENV_PATH, lines.join('\n') + '\n', { mode: 0o600 });
    fs.chmodSync(TELEGRAM_ENV_PATH, 0o600);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'could not save it: ' + e.message });
  }

  sendJSON(res, 200, { ok: true, saved: true, masked: '\u2022'.repeat(8) + value.slice(-4) });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(idleChecker);
  clearTimeout(hardCap);
  server.close();
  // Don't let lingering keep-alive sockets hold the process open.
  setTimeout(() => process.exit(code), 250).unref();
}

const idleChecker = setInterval(() => {
  // Before the first heartbeat, "idle" just means the human hasn't opened
  // the link yet -- that round trip (read the URL, switch apps, open a
  // browser) routinely takes longer than 15s, so it gets a 180s grace.
  // Once a heartbeat has landed we know a tab is open, so the normal 15s
  // idle timeout (tab closed) applies.
  const limit = heartbeatReceived ? HEARTBEAT_IDLE_MS : FIRST_HEARTBEAT_GRACE_MS;
  if (Date.now() - lastHeartbeat > limit) {
    const reason = heartbeatReceived ? 'no heartbeat for 15s (tab closed)' : 'no heartbeat within 180s of starting (link never opened)';
    console.log(`[jarvis-setup] ${reason} -- shutting down.`);
    shutdown(0);
  }
}, HEARTBEAT_CHECK_MS);

const hardCap = setTimeout(() => {
  console.log('[jarvis-setup] 10 minute hard cap reached -- shutting down.');
  shutdown(0);
}, HARD_CAP_MS);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

server.listen(0, '127.0.0.1', () => {
  port = server.address().port;
  lastHeartbeat = Date.now();
  const url = `http://127.0.0.1:${port}/?t=${TOKEN}`;
  console.log('Jarvis setup is running:');
  console.log('');
  console.log(`  ${url}`);
  console.log('');
  console.log('Open that in a browser. This waits up to 180s for that first open, then');
  console.log('drops to a 15s grace after the tab closes, and shuts down after 10 minutes');
  console.log('no matter what. Closing this terminal also stops it. Reopen anytime with');
  console.log('/jarvis-setup.');

  // commands/jarvis-setup.md tells the AGENT not to open this link itself
  // (it's a page the human interacts with, not something to fetch) -- this
  // is different: the SERVER opening the human's actual browser for them,
  // same as `npm create vite` or similar CLIs do. Best-effort and silent;
  // the URL above is printed either way so there's always a fallback.
  try {
    const opener = IS_MAC
      ? ['open', [url]]
      : IS_WIN
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // ignore -- the printed URL is the fallback
  }

  const failing = PREFLIGHT.filter((c) => c.required && !c.ok);
  const optionalMissing = PREFLIGHT.filter((c) => !c.required && !c.ok);
  console.log('');
  if (failing.length) {
    console.log('Preflight found issues (fix commands also shown on the page):');
    for (const c of failing) console.log(`  - ${c.label}: ${c.detail}`);
  } else {
    console.log('Preflight: all required tools look good.');
  }
  if (optionalMissing.length) {
    console.log('Optional, not required: ' + optionalMissing.map((c) => c.label).join(', ') + ' not found.');
  }
});
