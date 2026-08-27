#!/usr/bin/env node
// jarvis-plugin setup server (SPEC.md decision 6).
//
// Ephemeral, loopback-only, zero dependencies. Serves the setup page,
// writes the hub config, and shuts itself down. Never forks, never
// detaches, never listens on anything but 127.0.0.1.
//
// Lifecycle: born from `/jarvis-setup`, dies when the browser tab stops
// heartbeating (15s), when 10 minutes pass regardless, or when the
// terminal that spawned it is killed (SIGINT/SIGTERM/parent exit).

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HEARTBEAT_IDLE_MS = 15_000; // no heartbeat for this long -> exit
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
});

// Secrets this server is willing to write on the user's behalf. Anything
// else is rejected outright -- this is not a generic env-var writer.
const ALLOWED_SECRETS = new Set(['TELEGRAM_BOT_TOKEN', 'FAL_KEY']);

const TOKEN = crypto.randomBytes(24).toString('hex');
const PAGE_TEMPLATE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');

let hubDir = DEFAULT_HUB;
let config = loadConfig(hubDir);
let lastHeartbeat = Date.now();
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

  try {
    writeConfig();
  } catch {
    return sendJSON(res, 500, { ok: false, error: 'failed to write config' });
  }

  // Both are idempotent and cheap, so just run them on every save rather
  // than trying to detect "did the hub actually change" -- that also keeps
  // the pointer self-healing if it's ever deleted out from under the hub.
  const hubPointer = writeHubPointer(config.hub);
  const seed = seedHub(config.hub);

  sendJSON(res, 200, { ok: true, config, hub_pointer: hubPointer, seed });
}

function handleHeartbeat(req, res) {
  lastHeartbeat = Date.now();
  sendJSON(res, 200, { ok: true });
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
    if (req.method === 'POST' && url.pathname === '/api/config') return await handleConfig(req, res);
    if (req.method === 'POST' && url.pathname === '/api/heartbeat') return handleHeartbeat(req, res);
    if (req.method === 'POST' && url.pathname === '/api/secret') return await handleSecret(req, res);
  } catch {
    return sendJSON(res, 500, { ok: false, error: 'internal error' });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

let shuttingDown = false;
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
  if (Date.now() - lastHeartbeat > HEARTBEAT_IDLE_MS) {
    console.log('[jarvis-setup] no heartbeat for 15s (tab closed) -- shutting down.');
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
  console.log('Open that in a browser. This only runs while the tab stays open');
  console.log('(15s grace after it closes) and shuts down after 10 minutes no matter what.');
  console.log('Closing this terminal also stops it. Reopen anytime with /jarvis-setup.');
});
