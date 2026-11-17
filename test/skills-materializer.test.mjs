// Tests for setup/skills-materializer.mjs, run against a throwaway plugin root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSkillEnabled } from '../setup/skills-materializer.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mat-'));
  fs.mkdirSync(path.join(r, 'skills', 'grill-me'), { recursive: true });
  fs.writeFileSync(path.join(r, 'skills', 'grill-me', 'SKILL.md'), '# grill-me\n');
  fs.mkdirSync(path.join(r, 'optional-skills', 'recall'), { recursive: true });
  fs.writeFileSync(path.join(r, 'optional-skills', 'recall', 'SKILL.md'), '# recall\n');
  return r;
}

test('a skill shipped in skills/ counts as enabled', async () => {
  const r = root();
  assert.deepEqual(await setSkillEnabled(r, 'grill-me', true), { ok: true, action: 'already-enabled' });
});

test('a shipped skill survives a disable/enable round trip unchanged', async () => {
  const r = root();
  const off = await setSkillEnabled(r, 'grill-me', false);
  assert.equal(off.ok, true, off.error);
  assert.equal(off.action, 'disabled');
  assert.equal(fs.existsSync(path.join(r, 'skills', 'grill-me')), false);
  assert.ok(fs.existsSync(path.join(r, 'optional-skills', 'grill-me', 'SKILL.md')));
  assert.equal((await setSkillEnabled(r, 'grill-me', false)).action, 'already-disabled');

  const on = await setSkillEnabled(r, 'grill-me', true);
  assert.equal(on.ok, true, on.error);
  assert.equal(on.action, 'enabled');
  const st = fs.lstatSync(path.join(r, 'skills', 'grill-me'));
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), 'moved back as a real directory');
  assert.deepEqual(fs.readdirSync(path.join(r, 'skills', 'grill-me')), ['SKILL.md'], 'marker removed');
  assert.equal(fs.existsSync(path.join(r, 'optional-skills', 'grill-me')), false);
});

test('a shipped skill is not moved over an existing optional-skills copy', async () => {
  const r = root();
  fs.mkdirSync(path.join(r, 'optional-skills', 'grill-me'));
  const off = await setSkillEnabled(r, 'grill-me', false);
  assert.equal(off.ok, false);
  assert.ok(fs.existsSync(path.join(r, 'skills', 'grill-me', 'SKILL.md')));
});

test('an optional skill is still enabled by symlink and disabled by unlink', async () => {
  const r = root();
  assert.equal((await setSkillEnabled(r, 'recall', true)).action, 'enabled');
  assert.ok(fs.lstatSync(path.join(r, 'skills', 'recall')).isSymbolicLink());
  assert.equal((await setSkillEnabled(r, 'recall', false)).action, 'disabled');
  assert.ok(fs.existsSync(path.join(r, 'optional-skills', 'recall', 'SKILL.md')));
});
