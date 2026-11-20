// The setup page (setup/page.html) is one inline document served by setup/server.mjs.
// These tests pin the wiring between the two, the copy Or approved for the tree, and
// the rules the page lives by (no outside loads, reduced motion, both themes).
//   node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(ROOT, 'setup', 'page.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'setup', 'server.mjs'), 'utf8');
const skills = JSON.parse(fs.readFileSync(path.join(ROOT, 'setup', 'skills-catalog.json'), 'utf8')).skills;
const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'setup', 'tools-catalog.json'), 'utf8')).tools;

test('wiring: every API route the page calls exists on the server, and every old route is still called', () => {
  const called = new Set([...page.matchAll(/'(\/api\/[a-z-]+(?:\/[a-z]+)?)(?:\?[^']*)?'/g)].map((m) => m[1]));
  const routes = new Set([...server.matchAll(/url\.pathname === '([^']+)'/g)].map((m) => m[1]));
  for (const r of called) assert.ok(routes.has(r), `page calls ${r} but the server has no such route`);
  // The routes the page used before the tree (git-init was never called by the page).
  const used = ['/api/state', '/api/preflight', '/api/config', '/api/heartbeat', '/api/secret', '/api/telegram-install', '/api/telegram-status',
    '/api/telegram-token', '/api/skills', '/api/setup-all', '/api/install-tool', '/api/tools', '/api/tools/install', '/api/tools/connect'];
  for (const r of used) assert.ok(called.has(r), `page no longer calls ${r}`);
});

test('tree: skills and tools install through the existing endpoints with the documented bodies', () => {
  assert.match(page, /post\('\/api\/skills', \{ id: it\.id, enabled: true \}\)/, 'a skill is switched on with POST /api/skills {id, enabled}');
  assert.match(page, /post\('\/api\/skills', \{ id: it\.id, enabled: false \}\)/, 'an installed skill can be switched off');
  assert.match(page, /isMcp \? '\/api\/tools\/connect' : '\/api\/tools\/install', \{ id: it\.id \}/, 'an mcp tool is connected, the rest installed, by id');
});

test('tree: Or\'s copy is exact, and exactly one control reads "להתקין הכול"', () => {
  assert.ok(page.includes("helper: 'בחרו נושא כדי לראות מה יש בו ולסמן מה להתקין.'"), 'helper line under the tree');
  assert.equal(page.split('להתקין הכול').length - 1, 1, 'the install-everything label appears once');
  assert.ok(page.includes("installAll: 'להתקין הכול'"));
  assert.ok(!page.includes('להתקין את הכול'), 'no near-duplicate label');
});

test('tree: six topics + Animation twig; every catalog category lands on a topic', () => {
  for (const k of ['core', 'research', 'notes', 'design', 'build', 'media']) assert.match(page, new RegExp(`key: '${k}'`));
  const mapped = new Set([...page.match(/const TOPIC_DEF = \[([\s\S]*?)\n\];/)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
  const cats = new Set([...skills.map((s) => s.category), ...tools.map((t) => t.category)].filter((c) => c && c !== 'workspace'));
  for (const c of cats) assert.ok(mapped.has(c), `catalog category "${c}" has no topic on the tree (it would fall into Essentials by accident)`);
  assert.match(page, /it\.sub === 'animation'/, 'Animation is read from the catalog subgroup');
});

test('page: loads nothing from outside (the CSP forbids it), no demo CDN, fonts are the system stack', () => {
  assert.ok(!/fonts\.(googleapis|gstatic)|<link[^>]+href=["']https?:|<script[^>]+src=|@import|cdn\./i.test(page));
  assert.ok(!/(src|href)=["']https?:\/\/[^"']+\.(png|jpe?g|webp|woff2?|css|js)/i.test(page));
  assert.match(server, /default-src 'none'/);
});

test('page: the owl is the felt photo set served from setup/assets, never a drawn stand-in', () => {
  const poses = [...page.match(/const POSES = \[([^\]]*)\]/)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(poses.length >= 8);
  for (const p of poses) assert.ok(fs.existsSync(path.join(ROOT, 'setup', 'assets', 'shufi', p + '.webp')), `${p}.webp exists`);
  assert.ok(!page.includes('data:image/jpeg;base64'), 'no inline base64 owl any more');
});

test('page: both themes, reduced motion, visible focus, Hebrew right to left', () => {
  assert.match(page, /:root\[data-theme="light"\]/);
  assert.match(page, /:root, :root\[data-theme="dark"\]/);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none !important/);
  assert.match(page, /:focus-visible \{ outline: 3px solid var\(--focus\)/);
  assert.match(page, /d\.dir = l === 'he' \? 'rtl' : 'ltr'/);
  assert.match(page, /key === 'Escape' && TOPIC/, 'Escape closes the topic panel');
  assert.match(page, /\.btag:focus-visible/);
});

// Real server: the page, its CSP, and the owl files behind the token.
function startServer() {
  return new Promise((resolve, reject) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shufi-page-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'setup', 'server.mjs')], {
      env: { PATH: process.env.PATH, HOME: home, JARVIS_HUB: path.join(home, 'hub'), JARVIS_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not start')); }, 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/);
      if (m) { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${m[1]}`, token: m[2] }); }
    });
  });
}

test('server: serves the page with its CSP, the owl poses behind the token, and the catalogs', async () => {
  const { child, base, token } = await startServer();
  try {
    const home = await fetch(`${base}/?t=${token}`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy') || '', /connect-src 'self'/);
    const html = await home.text();
    assert.ok(html.includes('להתקין הכול') && html.includes('בחרו נושא כדי לראות מה יש בו ולסמן מה להתקין.'));
    const pose = await fetch(`${base}/assets/shufi/idle.webp?t=${token}`);
    assert.equal(pose.status, 200);
    assert.equal(pose.headers.get('content-type'), 'image/webp');
    assert.equal((await fetch(`${base}/assets/shufi/idle.webp`)).status, 403, 'no token, no owl');
    assert.equal((await fetch(`${base}/assets/shufi/..%2Fserver.webp?t=${token}`)).status, 404, 'the asset route is an allowlist, not a path join');
    const api = (p) => fetch(`${base}${p}`, { headers: { 'x-jarvis-token': token } }).then((r) => r.json());
    const sk = await api('/api/skills');
    const tl = await api('/api/tools');
    assert.equal(sk.skills.length, skills.length);
    assert.equal(tl.tools.length, tools.length);
  } finally { child.kill(); }
});
