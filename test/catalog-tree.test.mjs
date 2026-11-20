// The skills catalog's tree shape: Animation is a sub-branch of Design (a `subgroup`),
// recommended-external rows (`install`) have no directory and are never toggled.
//   node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'setup', 'skills-catalog.json'), 'utf8')).skills;
const page = fs.readFileSync(path.join(ROOT, 'setup', 'page.html'), 'utf8');
const has = (dir, id) => fs.existsSync(path.join(ROOT, dir, id));

test('catalog: Animation is a branch inside Design, not a top-level group', () => {
  assert.ok(!catalog.some((s) => s.category === 'animation'), 'no top-level animation category');
  const anim = catalog.filter((s) => s.subgroup === 'animation');
  assert.ok(anim.length >= 5, 'the animation branch has its rows');
  for (const s of anim) assert.equal(s.category, 'design', s.id + ' hangs under design');
});

test('catalog: every subgroup sits under a category that also has a plain row, and the page can label it', () => {
  for (const s of catalog.filter((x) => x.subgroup)) {
    assert.ok(catalog.some((x) => x.category === s.category && !x.subgroup), s.category + ' needs a non-subgroup row');
    assert.match(page, new RegExp('SUBNAMES = \\{[^}]*\\b' + s.subgroup + ':'), 'page.html labels subgroup ' + s.subgroup);
  }
  assert.ok(page.includes("className: 'branch'"), 'page.html draws subgroups as a branch');
});

test('catalog: ids are unique; install rows have no directory, the rest do', () => {
  assert.equal(new Set(catalog.map((s) => s.id)).size, catalog.length);
  for (const s of catalog) {
    const dir = has('skills', s.id) || has('optional-skills', s.id);
    if (s.install) {
      assert.ok(Array.isArray(s.install) && s.install.length > 0 && s.install.every((c) => typeof c === 'string'), s.id + ' install is a list of commands');
      assert.ok(!dir, s.id + ' is external, must not have a directory');
      assert.equal(s.default, false, s.id + ' is never on by default');
    } else {
      assert.ok(dir, s.id + ' needs a directory under skills/ or optional-skills/');
    }
  }
});

test('cli: skills --json carries category+subgroup, and an external row cannot be switched on', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tree-'));
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'setup', 'agent.mjs'), ...a], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  const listed = run('skills', '--json');
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout);
  const gsap = rows.find((s) => s.id === 'animation-gsap');
  assert.equal(gsap.category, 'design');
  assert.equal(gsap.subgroup, 'animation');
  assert.equal(gsap.enabled, false);
  const en = run('enable', 'animation-gsap');
  assert.notEqual(en.status, 0, 'enable must fail for an external row');
  assert.match(en.stdout + en.stderr, /installed from its own source/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'skills', 'animation-gsap')));
});
