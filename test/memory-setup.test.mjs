// memory-setup skill: builds the memory system for a fresh user. Every run is a real subprocess
// with a temp HOME; nothing here touches the real home directory.
//   node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBlock, planBlock } from '../skills/memory-setup/scripts/memory-setup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skills', 'memory-setup', 'scripts', 'memory-setup.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-msetup-'));
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const ENV = (home, extra = {}) => ({ PATH: '/usr/bin:/bin', HOME: home, ...extra });
function setup(home, args = [], extra = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: ENV(home, extra), encoding: 'utf8', timeout: 15000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
// A hash of every path (type, name) and every file's bytes: any write, even of the same bytes to a
// new file, shows up. mtimes are not hashed (a rewrite of identical bytes would not count; the
// "exists" checks use wx so that cannot happen).
function treeHash(dir) {
  const h = crypto.createHash('sha1');
  (function w(d) {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      h.update(path.relative(dir, p) + (st.isDirectory() ? '/' : ':'));
      if (st.isDirectory()) w(p); else h.update(fs.readFileSync(p));
    }
  })(dir);
  return h.digest('hex');
}

test('fresh empty HOME: zero config creates the whole system and exits 0', () => {
  const home = tmp();
  const r = setup(home);
  assert.equal(r.code, 0, r.err);
  const hub = path.join(home, 'jarvis-hub');
  for (const f of ['MEMORY.md', 'working-rules.md', 'example-feedback-rule.md', 'knowledge/README.md', 'knowledge/index.md',
    'knowledge/memory-conventions.md', 'raw/README.md', 'wiki/README.md', 'wiki/index.md']) {
    assert.ok(fs.existsSync(path.join(hub, f)), f);
  }
  assert.equal(fs.readFileSync(path.join(home, '.jarvis-hub-path'), 'utf8').trim(), hub, 'pointer so the hooks find the hub');
  const md = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.match(md, /^<!-- shufi-memory:begin v1 -->\n/);
  assert.ok(md.includes(path.join(hub, 'knowledge', 'index.md')));
  assert.match(r.out, /memory-check .*wired.*clean/);
  assert.match(r.out, /correction-capture .*undo/);
  assert.match(r.out, /qmd/);
  assert.match(r.out, /Done: \d+ created, 0 updated/);
});

test('second run changes nothing and says so', () => {
  const home = tmp();
  setup(home);
  const before = treeHash(home);
  const r = setup(home);
  assert.equal(r.code, 0);
  assert.equal(treeHash(home), before);
  assert.match(r.out, /Nothing to do/);
  assert.doesNotMatch(r.out, /\bcreated {2}|\bupdated {2}/);
});

test('--dry-run writes nothing at all, not even on an empty HOME', () => {
  const home = tmp();
  const before = treeHash(home);
  const r = setup(home, ['--dry-run']);
  assert.equal(r.code, 0);
  assert.equal(treeHash(home), before);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.match(r.out, /DRY RUN/);
  assert.match(r.out, /would create/);
  assert.match(r.out, /Plan: \d+ to create/);
});

test('--dry-run on a finished setup says nothing to do', () => {
  const home = tmp();
  setup(home);
  const before = treeHash(home);
  const r = setup(home, ['--dry-run']);
  assert.equal(treeHash(home), before);
  assert.match(r.out, /Nothing to do/);
});

test('existing CLAUDE.md: custom text is kept byte for byte outside the block', () => {
  const home = tmp();
  const f = path.join(home, '.claude', 'CLAUDE.md');
  // custom text, Hebrew, CRLF mixed in, a stray invalid UTF-8 byte, and no trailing newline
  const original = Buffer.concat([Buffer.from('# My rules\r\n- תמיד בעברית\r\n- be brief'), Buffer.from([0xff, 0xfe]), Buffer.from(' tail')]);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, original);
  const r = setup(home);
  assert.equal(r.code, 0);
  const after = fs.readFileSync(f);
  assert.ok(after.subarray(0, original.length).equals(original), 'original bytes are an untouched prefix');
  const rest = after.subarray(original.length).toString('utf8');
  assert.match(rest, /shufi-memory:begin v1/);
  assert.ok(rest.includes('\r\n'), 'block follows the file line endings');
  assert.ok(fs.readFileSync(f + '.shufi-bak').equals(original), 'one backup of the original');
  // second run: no change
  const hash = treeHash(home);
  setup(home);
  assert.equal(treeHash(home), hash);
});

test('block in the middle of a user file is refreshed in place; both sides stay byte-identical', () => {
  const home = tmp();
  const f = path.join(home, '.claude', 'CLAUDE.md');
  const head = 'before\n\nuser text one\n';
  const tail = '\nuser text two (עברית)\nlast line, no newline';
  write(f, head + buildBlock('/old/hub') + tail);
  const r = setup(home);
  assert.equal(r.code, 0);
  const after = fs.readFileSync(f, 'utf8');
  assert.ok(after.startsWith(head + '<!-- shufi-memory:begin v1 -->'));
  assert.ok(after.endsWith(END_OF(tail)), 'tail untouched');
  assert.ok(after.includes(path.join(home, 'jarvis-hub')) && !after.includes('/old/hub'));
  assert.equal((after.match(/shufi-memory:begin/g) || []).length, 1);
  assert.match(r.out, /refreshed/);
});
const END_OF = (tail) => '<!-- shufi-memory:end -->\n' + tail;

test('damaged markers: file left alone, reported', () => {
  const home = tmp();
  const f = path.join(home, '.claude', 'CLAUDE.md');
  const broken = 'x\n<!-- shufi-memory:begin v1 -->\nhalf a block, no end marker\n';
  write(f, broken);
  const r = setup(home);
  assert.equal(fs.readFileSync(f, 'utf8'), broken);
  assert.match(r.out, /skipped .*CLAUDE.md.*damaged/);
  assert.equal(fs.existsSync(f + '.shufi-bak'), false);
});

test('a block from a newer plugin version is left alone', () => {
  const home = tmp();
  const f = path.join(home, '.claude', 'CLAUDE.md');
  const v2 = '<!-- shufi-memory:begin v2 -->\nnewer\n<!-- shufi-memory:end -->\n';
  write(f, v2);
  setup(home);
  assert.equal(fs.readFileSync(f, 'utf8'), v2);
});

test('planBlock: empty file gets the block, current block is unchanged', () => {
  const b = buildBlock('/h');
  assert.equal(planBlock(Buffer.alloc(0), b).next.toString(), b);
  assert.equal(planBlock(Buffer.from('a\n\n' + b), b).action, 'unchanged');
  assert.equal(planBlock(Buffer.from('a\r\n\r\n' + b.replace(/\n/g, '\r\n')), b).action, 'unchanged');
});

test('CLAUDE_CONFIG_DIR is honoured for the user-level CLAUDE.md', () => {
  const home = tmp(); const cfg = path.join(tmp(), 'cfg');
  setup(home, [], { CLAUDE_CONFIG_DIR: cfg });
  assert.ok(fs.existsSync(path.join(cfg, 'CLAUDE.md')));
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
});

test('existing knowledge/index.md and wiki files are untouched; missing neighbours are created', () => {
  const home = tmp();
  const hub = path.join(home, 'jarvis-hub');
  write(path.join(hub, 'knowledge', 'index.md'), 'MY OWN INDEX\n');
  write(path.join(hub, 'wiki', 'index.md'), 'MY WIKI\n');
  const r = setup(home);
  assert.equal(fs.readFileSync(path.join(hub, 'knowledge', 'index.md'), 'utf8'), 'MY OWN INDEX\n');
  assert.equal(fs.readFileSync(path.join(hub, 'wiki', 'index.md'), 'utf8'), 'MY WIKI\n');
  assert.ok(fs.existsSync(path.join(hub, 'knowledge', 'README.md')));
  assert.match(r.out, /exists, left as is {2}~\/jarvis-hub\/knowledge\/index\.md/);
});

test('a hub that already has MEMORY.md gets no seed or example files', () => {
  const home = tmp();
  const hub = path.join(home, 'jarvis-hub');
  write(path.join(hub, 'MEMORY.md'), '# mine\n');
  setup(home);
  assert.equal(fs.readFileSync(path.join(hub, 'MEMORY.md'), 'utf8'), '# mine\n');
  assert.equal(fs.existsSync(path.join(hub, 'working-rules.md')), false);
  assert.equal(fs.existsSync(path.join(hub, 'example-user-fact.md')), false);
  assert.ok(fs.existsSync(path.join(hub, 'wiki', 'index.md')));
});

test('JARVIS_HUB: used as is, no pointer file written; --hub wins over the env', () => {
  const home = tmp(); const hub = path.join(tmp(), 'h1'); const hub2 = path.join(tmp(), 'h2');
  setup(home, [], { JARVIS_HUB: hub });
  assert.ok(fs.existsSync(path.join(hub, 'MEMORY.md')));
  assert.equal(fs.existsSync(path.join(home, '.jarvis-hub-path')), false);
  setup(home, ['--hub', hub2], { JARVIS_HUB: hub });
  assert.ok(fs.existsSync(path.join(hub2, 'MEMORY.md')));
  assert.ok(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8').includes(hub2), 'block follows the hub');
});

test('--lang he prints Hebrew; --lang en does not; LANG picks the default', () => {
  const he = setup(tmp(), ['--lang', 'he']);
  assert.match(he.out, /[֐-׿]/);
  assert.match(he.out, /נוצר/);
  const en = setup(tmp(), ['--lang', 'en']);
  assert.doesNotMatch(en.out, /[֐-׿]/);
  assert.match(setup(tmp(), [], { LANG: 'he_IL.UTF-8' }).out, /[֐-׿]/);
  assert.doesNotMatch(setup(tmp(), [], { LANG: 'en_US.UTF-8' }).out, /[֐-׿]/);
  assert.doesNotMatch(setup(tmp(), ['--lang', 'xx']).out, /[֐-׿]/, 'unknown language falls back');
});

test('Hebrew seed files are Hebrew, frontmatter keys stay English', () => {
  const home = tmp();
  setup(home, ['--lang', 'he']);
  const k = fs.readFileSync(path.join(home, 'jarvis-hub', 'knowledge', 'index.md'), 'utf8');
  assert.match(k, /^---\nname: knowledge-index\n/);
  assert.match(k, /[֐-׿]/);
  assert.equal((fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8').match(/[֐-׿]/g) || []).length, 0, 'the always-on block stays English');
});

test('kill switches are reported, and the memory checker does not run when it is off', () => {
  const home = tmp();
  const hub = path.join(home, 'jarvis-hub');
  write(path.join(hub, '.memory-check.off'), '');
  write(path.join(hub, '.correction-capture.off'), '');
  const r = setup(home);
  assert.match(r.out, /memory-check .*OFF/);
  assert.match(r.out, /correction-capture .*OFF/);
  assert.equal(fs.existsSync(path.join(hub, '.memory-check-stamp')), false, 'setup never writes the checker stamp or reports');
  assert.equal(fs.existsSync(path.join(hub, 'reports')), false);
});

test('a stale fact in an existing hub shows up in the setup summary', () => {
  const home = tmp();
  const hub = path.join(home, 'jarvis-hub');
  write(path.join(hub, 'MEMORY.md'), '# Memory\n\n## Project\n- [Old](project_old.md) - x\n');
  write(path.join(hub, 'project_old.md'), '---\nname: old\ndescription: d\n---\nRun `/Users/nobody/gone-script.sh`\n');
  const r = setup(home);
  assert.match(r.out, /memory-check .*1 possibly-stale items/);
});

test('qmd: found on PATH prints the optional index command, absent prints one install line; nothing is run', () => {
  const home = tmp(); const bin = tmp();
  fs.writeFileSync(path.join(bin, 'qmd'), '#!/bin/sh\ntouch "$HOME/qmd-was-run"\n', { mode: 0o755 });
  const yes = setup(home, [], { PATH: '/usr/bin:/bin:' + bin });
  assert.match(yes.out, /qmd found .*qmd collection add .*jarvis-hub --name memory && qmd embed/);
  assert.equal(fs.existsSync(path.join(home, 'qmd-was-run')), false);
  const no = setup(tmp());
  assert.match(no.out, /qmd not found .*npm install -g @tobilu\/qmd/);
});

test('the always-on block stays small (at most 600 bytes with a long hub path)', () => {
  const b = buildBlock('/Users/someone/Documents/my-long-folder-name/jarvis-hub');
  assert.ok(Buffer.byteLength(b) <= 600, String(Buffer.byteLength(b)));
  assert.match(b, /MUST read .*knowledge\/index\.md/);
});

test('SKILL.md: name matches folder, short description, trigger first, He + En triggers', () => {
  const s = fs.readFileSync(path.join(ROOT, 'skills', 'memory-setup', 'SKILL.md'), 'utf8');
  assert.match(s, /^---\nname: memory-setup\n/);
  const d = /\ndescription: (.+)\n/.exec(s)[1];
  assert.ok(d.length <= 220, 'description length ' + d.length);
  assert.match(d, /^"?[Ss]et up memory/);
  assert.match(d, /תגדיר זיכרון/);
  assert.ok(s.includes('memory-setup.mjs'));
});

test('a setup script run never touches the real home', () => {
  const home = tmp();
  const real = os.homedir();
  const marker = path.join(real, '.claude', 'CLAUDE.md');
  const before = fs.existsSync(marker) ? fs.statSync(marker).mtimeMs : null;
  setup(home);
  assert.equal(fs.existsSync(marker) ? fs.statSync(marker).mtimeMs : null, before);
});
