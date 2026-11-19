// Memory core: the memory checker, the correction-to-rule hook, and a fresh-install walk.
// Every hook runs as a real subprocess with a temp HOME and a temp state dir: nothing here touches
// the real home directory or a real hub.
//   node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkMemory, renderReport, parsePatterns, classifySpan, runCheck } from '../hooks/lib/memory-check-core.mjs';
import { unwrapPrompt, detectCorrection, buildInstruction } from '../hooks/lib/correction-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(ROOT, 'hooks');
const TEMPLATE = path.join(ROOT, 'memory-template');
const FIXTURES = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'correction-fixtures.json'), 'utf8'));
const DAY = 24 * 3600 * 1000;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-core-'));
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const sid = () => 's' + crypto.randomBytes(4).toString('hex');

function mkEnv(extra = {}) {
  const home = tmp();
  return { home, env: { PATH: process.env.PATH, HOME: home, JARVIS_STATE_DIR: path.join(home, '.state'), ...extra } };
}
function mkTemplateHub(home) {
  const hub = path.join(home, 'jarvis-hub');
  fs.cpSync(TEMPLATE, hub, { recursive: true });
  return hub;
}
function run(script, env, input = '') {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [path.join(HOOKS, script)], { input, env, encoding: 'utf8', timeout: 10000 });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: performance.now() - t0 };
}
const prompt = (text, session = sid()) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: '/tmp', prompt: text });
const startInput = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'x', cwd: '/tmp', source: 'startup' });

// Hash every file except what the checker legitimately writes (stamp, reports/).
function snapshot(hub) {
  const out = {};
  (function walk(d) {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const rel = path.relative(hub, p);
      if (rel === '.memory-check-stamp' || rel === 'reports') continue;
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  })(hub);
  return out;
}
function tree(dir) {
  const out = [];
  (function w(d) { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); out.push(path.relative(dir, p)); if (fs.statSync(p).isDirectory()) w(p); } })(dir);
  return out;
}
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

// ------------------------------------------------------------------ checker: unit
function seedHub(files) {
  const hub = tmp();
  for (const [n, s] of Object.entries(files)) write(path.join(hub, n), s);
  return hub;
}
const FM = (extra = '') => '---\nname: n\ndescription: d\nmetadata:\n  type: project\n' + extra + '---\n';
const check = (hub, extra = {}) => checkMemory({ hub, home: '/nohome', today: '2026-11-19', ...extra });
const types = (r) => r.findings.map((f) => f.type);

test('checker: template hub is clean (comment and code-span link examples are not links)', () => {
  const r = check(TEMPLATE);
  assert.deepEqual(r.findings, []);
  assert.equal(r.stats.partial, false);
});

test('checker: dead path is found; alive, fenced, commented, URL and unresolvable paths are not', () => {
  const alive = tmp();
  const hub = seedHub({
    'MEMORY.md': '# Memory\n- [A](a.md) - x\n',
    'a.md': FM() + [
      'dead: `/Users/nobody/gone-' + process.pid + '/file.txt`',
      'alive: `' + alive + '`',
      'url: `https://example.com/a/b`',
      'relative: `app/routes/uploads.py` and `dev/web/` and `/cascade`',
      'glob: `/Users/nobody/*.log` and `~/x/<name>/y`',
      '```',
      '`/Users/nobody/in-a-fence`',
      '```',
      '<!-- `/Users/nobody/in-a-comment` -->',
    ].join('\n') + '\n',
  });
  const r = check(hub);
  const dead = r.findings.filter((f) => f.type === 'dead_path');
  assert.equal(dead.length, 1);
  assert.match(dead[0].detail, /gone-/);
  assert.equal(dead[0].line, 7);
  assert.ok(r.stats.unresolvable >= 3, 'path-shaped but ambiguous text is counted, not reported');
});

test('checker: a missing path on a "moved/gone" line is a hint, not a finding (English and Hebrew)', () => {
  const hub = seedHub({
    'MEMORY.md': '- [A](a.md) - x\n',
    'a.md': FM() + 'The tool `/Users/nobody/old-tool` was moved to the archive.\nהקובץ `/Users/nobody/old-file` הועבר לארכיון.\nStill needed: `/Users/nobody/live-claim`.\n',
  });
  const r = check(hub);
  assert.equal(r.findings.filter((f) => f.type === 'dead_path').length, 1);
  assert.match(r.findings[0].detail, /live-claim/);
  assert.equal(r.hints.filter((h) => h.type === 'dead_path').length, 2);
  assert.match(renderReport({ today: '2026-11-19', ...r }), /Not counted/);
});

test('checker: dangling index link, unindexed file, wikilink counts as indexed, system files ignored', () => {
  const hub = seedHub({
    'MEMORY.md': '- [Gone](gone.md) - x\n- [[wiki-note]] - y\n- [Ext](https://x.dev/a.md)\n- [Anchor](#top)\n',
    'wiki-note.md': FM(),
    'orphan.md': FM(),
    'CONTEXT.md': FM() + '`/Users/nobody/history`',
    'patterns.md': '# p\n',
    'conversation-log.md': '`/Users/nobody/history`',
    'no-frontmatter-note.md': 'just a note',
    'a.bak-2026.md': FM(),
  });
  const r = check(hub);
  assert.deepEqual(types(r).sort(), ['dangling_index', 'unindexed']);
  assert.match(r.findings.find((f) => f.type === 'unindexed').detail, /orphan\.md/);
});

test('checker: hub lifecycle states raise no false alarm (after the first /done, on an upgraded hub)', () => {
  // After /done: the three placeholders and their MEMORY.md lines are gone.
  const done = tmp();
  fs.cpSync(TEMPLATE, done, { recursive: true });
  for (const f of ['example-feedback-rule.md', 'example-project-note.md', 'example-user-fact.md']) fs.rmSync(path.join(done, f));
  write(path.join(done, 'MEMORY.md'), fs.readFileSync(path.join(done, 'MEMORY.md'), 'utf8').split('\n').filter((l) => !/\]\(example-/.test(l)).join('\n'));
  assert.deepEqual(check(done).findings, [], 'placeholders removed together with their index lines');
  // Upgraded hub: working-rules.md was added by setup, MEMORY.md was left alone (no index line for it).
  const up = seedHub({ 'MEMORY.md': '# Memory\n- [A](a.md) - x\n', 'a.md': FM(), 'working-rules.md': FM() });
  assert.deepEqual(check(up).findings, [], 'working-rules.md is loaded by session-start, not via the index');
  // Consolidation files at the top level are history, never records.
  const cons = seedHub({ 'MEMORY.md': '# m\n', 'CONTEXT.md': FM() + '`/Users/nobody/x`', 'conversation-log.md': FM(), 'patterns.md': FM() });
  assert.deepEqual(check(cons).findings, []);
});

test('checker: check: closed vocabulary (exists, absent, grep); unknown verbs are reported and never run', () => {
  const dir = tmp();
  write(path.join(dir, 'there.txt'), 'hello version 1.2.3\n');
  const sentinel = path.join(dir, 'PWNED');
  const hub = seedHub({
    'MEMORY.md': '- [A](a.md) - x\n- [B](b.md) - x\n',
    'a.md': FM('  check: exists ' + path.join(dir, 'there.txt') + '\n'),
    'b.md': '---\nname: b\ndescription: d\ncheck:\n  - absent ' + path.join(dir, 'there.txt') + '\n  - grep ' + path.join(dir, 'there.txt') + ' "version 1.2.3"\n  - grep ' + path.join(dir, 'there.txt') + ' "version 9"\n  - exists ' + path.join(dir, 'nope') + '\n  - version node 99\n  - rm -rf ' + dir + '\n  - exists $(touch ' + sentinel + ')\n  - grep ' + path.join(dir, 'there.txt') + ' x; touch ' + sentinel + '\n  - exists relative/path\n---\n',
  });
  const r = check(hub);
  const bd = r.findings.map((f) => f.type + ' ' + f.detail);
  assert.equal(r.findings.filter((f) => f.type === 'check_failed').length, 4, bd.join('\n'));
  assert.equal(r.findings.filter((f) => f.type === 'check_invalid').length, 4, bd.join('\n'));
  assert.ok(bd.some((s) => /unknown verb "version"/.test(s)));
  assert.ok(bd.some((s) => /unknown verb "rm"/.test(s)));
  assert.equal(fs.existsSync(sentinel), false, 'no check ever executes anything');
  assert.equal(fs.existsSync(path.join(dir, 'there.txt')), true);
  assert.equal(runCheck('exists /etc/hosts', '/h'), null);
});

test('checker: patterns.md records: overdue, malformed, hints; prose under ### and legacy bullets are ignored', () => {
  const hub = seedHub({
    'MEMORY.md': '# m\n',
    'patterns.md': [
      '# Patterns', '', '## Observed Patterns (3+ occurrences)', '',
      '- **legacy prose bullet (3x):** no review field, never a record',
      '### just-a-heading', 'free prose with no fields', '',
      '### ok-record', '- status: observed', '- count: 3', '- violations: 1', '- first: 2026-08-01', '- last: 2026-11-01', '- review: 2027-01-01', '- claim: keeps tests small', '- action: none yet', '- evidence:', '  - 2026-11-01 - "keep it small"', '',
      '### overdue-record', '- status: observed', '- count: 3', '- review: 2026-11-01', '- claim: c', '- action: none yet', '- evidence:', '  - 2026-10-01 - "x"', '',
      '### malformed-record', '- status: observed', '- count: 3', '- claim: ', '',
      '### flip-me', '- status: observed', '- review: 2027-01-01', '- claim: c', '- action: done', '- evidence: "x"', '',
      '## Applied Suggestions', '- flip-me is now a rule', '',
    ].join('\n'),
  });
  const r = check(hub);
  assert.deepEqual(types(r).sort(), ['malformed', 'review_overdue']);
  assert.match(r.findings.find((f) => f.type === 'malformed').detail, /malformed-record.*claim, evidence, review/);
  assert.match(r.findings.find((f) => f.type === 'review_overdue').detail, /18 day\(s\) past/);
  assert.deepEqual(r.hints.map((h) => h.type).sort(), ['none_yet_past_review', 'possibly_applied']);
  assert.equal(r.stats.patternRecords, 4);
  assert.equal(parsePatterns('### x\n- status: applied\n').records.length, 1);
});

test('checker: review dated today is not overdue; no patterns.md means no pattern checks', () => {
  const hub = seedHub({ 'MEMORY.md': '# m\n', 'patterns.md': '### r\n- status: applied\n- review: 2026-11-19\n- claim: c\n- evidence: "x"\n' });
  assert.deepEqual(check(hub).findings, []);
  assert.deepEqual(check(seedHub({ 'MEMORY.md': '# m\n' })).findings, []);
});

test('checker: stops at its time budget and says partial', () => {
  const hub = seedHub({ 'MEMORY.md': '- [A](a.md) - x\n', 'a.md': FM('') + '`/Users/nobody/x`\n' });
  let t = 0;
  const r = check(hub, { budgetMs: 150, startedAt: 0, now: () => (t += 100) }); // 1st check passes, 2nd is past 150
  assert.equal(r.stats.partial, true);
  assert.match(renderReport({ today: '2026-11-19', ...r }), /Partial/);
});

test('classifySpan: only unambiguous paths are judged', () => {
  assert.equal(classifySpan('/Users/nobody/x', '/h'), 'dead');
  assert.equal(classifySpan('~/nobody/x', '/h'), 'dead');
  assert.equal(classifySpan('/etc/hosts', '/h'), 'alive');
  assert.equal(classifySpan('app/routes/x.py', '/h'), 'unresolvable');
  assert.equal(classifySpan('/cascade', '/h'), 'unresolvable');
  assert.equal(classifySpan('npm install', '/h'), 'skip');
  assert.equal(classifySpan('https://a.b/c', '/h'), 'skip');
  assert.equal(classifySpan('/Users/nobody/x.py:123', '/h'), 'dead');
});

// ------------------------------------------------------------------ correction: unit
test('correction fixtures: every fires_on fires, every quiet_on is quiet (Hebrew and English)', () => {
  assert.ok(FIXTURES.fires_on.length >= 12 && FIXTURES.quiet_on.length >= 12);
  for (const lang of ['he', 'en']) {
    assert.ok(FIXTURES.fires_on.filter((f) => f.lang === lang).length >= 12, lang + ' fires_on >= 12');
    assert.ok(FIXTURES.quiet_on.filter((f) => f.lang === lang).length >= 12 - (lang === 'he' ? 0 : 0), lang + ' quiet_on >= 12');
  }
  const bad = [];
  for (const [kind, list] of [['fires_on', FIXTURES.fires_on], ['quiet_on', FIXTURES.quiet_on]]) {
    for (const f of list) {
      const text = unwrapPrompt(f.text);
      const hit = text && detectCorrection(text);
      if (!!hit !== (kind === 'fires_on')) bad.push(kind + ': ' + f.text + ' -> ' + JSON.stringify(hit));
    }
  }
  assert.deepEqual(bad, []);
});

test('correction: Hebrew prefix traps', () => {
  assert.equal(detectCorrection('שאמרתי לך לא לגעת'), null, 'ש + אמרתי is a relative clause (a reference), not a complaint');
  assert.equal(detectCorrection('הדבר שביקשתי ממך'), null, 'ש + ביקשתי likewise');
  assert.ok(detectCorrection('ואמרתי לך לא לגעת'), 'ו + אמרתי is a new clause: fires');
  assert.ok(detectCorrection('ולא אמרתי'), 'ו + לא fires');
  assert.equal(detectCorrection('הוא רצה לאמר משהו'), null, 'לאמר is not לא + אמרתי');
  assert.equal(detectCorrection('זה תמידי'), null, 'תמידי is a different word');
  assert.equal(detectCorrection('שאל תמר'), null, 'שאל is not אל');
  assert.equal(detectCorrection('מאמרתי'), null, 'מ + אמרתי alone is not a term anyway');
});

test('correction: weak terms need a directive, a short message and no question; long pastes only fire on strong terms', () => {
  assert.equal(detectCorrection('always'), null);
  assert.equal(detectCorrection('Is it always like this?'), null);
  assert.equal(detectCorrection('I always use tabs'), null);
  assert.ok(detectCorrection('Always use tabs.'));
  assert.equal(detectCorrection('Here is the log:\n' + 'line\n'.repeat(200) + 'always use tabs'), null);
  assert.ok(detectCorrection('no, I said stop. ' + 'x'.repeat(2000)), 'strong term in the head of a long message still fires');
});

test('correction: "I told/asked you" fires only when the clause starts there; stop and אל need a marker', () => {
  for (const t of ['I told you to stop.', 'No. I asked you to use tabs.', 'Okay, now I asked you to list them', 'Yes, I asked you for X', 'It is wrong, I told you so']) assert.ok(detectCorrection(t), t);
  for (const t of ['the file that I asked you to edit', 'what I told you', 'the codeword I told you', 'everything I asked you about']) assert.equal(detectCorrection(t), null, t);
  assert.ok(detectCorrection('Please stop pressing keys'));
  assert.ok(detectCorrection('Can you stop pressing keys?'));
  assert.ok(detectCorrection('Stop doing that.'));
  assert.equal(detectCorrection('Stop pressing keys.'), null, 'a bare imperative is an instruction');
  assert.ok(detectCorrection('Stop pressing keys again.'));
  assert.equal(detectCorrection('אל תשנה כלום'), null);
  assert.ok(detectCorrection('לא, אל תשנה'));
  assert.ok(detectCorrection('שוב אל תשנה את זה'));
  assert.ok(detectCorrection('אל תשנה, כבר אמרתי'));
  assert.equal(detectCorrection('ואל תשנה כלום ואל תמחק קבצים'), null);
  assert.equal(detectCorrection('You can always use the other model.'), null);
  assert.equal(detectCorrection('Always use tabs. ' + 'x'.repeat(250)), null, 'weak terms: 200 characters at most');
  assert.ok(detectCorrection('lets go. Not what I want.'));
});

test('pasted_content blocks are never read; the text around them is', () => {
  assert.equal(unwrapPrompt('merge it <pasted_content id="a">no, I said stop</pasted_content>'), 'merge it');
  assert.equal(unwrapPrompt('<channel source="plugin:telegram:telegram">ok <pasted_content>no, I said stop</pasted_content></channel>'), 'ok');
  assert.equal(unwrapPrompt('<pasted_content>only a paste</pasted_content>'), null);
  assert.equal(detectCorrection('fine <pasted_content>no, I said stop</pasted_content>'), null);
  assert.ok(detectCorrection('no, I said stop <pasted_content>x</pasted_content>'));
});

test('unwrapPrompt: Telegram channel tag is unwrapped, other < prompts and slash commands are skipped', () => {
  assert.equal(unwrapPrompt('<channel source="plugin:telegram:telegram" chat_id="5" ts="t">hello there</channel>'), 'hello there');
  assert.equal(unwrapPrompt('<channel source="plugin:telegram:telegram">a</channel>\n<channel source="plugin:telegram:telegram">b</channel>'), 'a\nb');
  assert.equal(unwrapPrompt('<channel source="plugin:slack:x">hi</channel>'), null);
  assert.equal(unwrapPrompt('<task-notification>x</task-notification>'), null);
  assert.equal(unwrapPrompt('/compact now'), null);
  assert.equal(unwrapPrompt('  plain  '), 'plain');
  assert.equal(unwrapPrompt(42), null);
  assert.equal(unwrapPrompt('   '), null);
});

test('correction: the injected line is short, plugin-built, and carries no prompt text', () => {
  const line = buildInstruction('/Users/someone/jarvis-hub', '/Users/someone');
  assert.ok(Buffer.byteLength(line) <= 215, 'bytes: ' + Buffer.byteLength(line));
  assert.match(line, /~\/jarvis-hub\/feedback_<slug>\.md/);
  for (const must of ['violations: 0', 'violations +1', "'undo'", 'Saved as a rule', 'index line', 'type: feedback', 'Why', 'How to apply']) assert.ok(line.includes(must), must);
  assert.equal((line.match(/\n/g) || []).length, 1);
});

// ------------------------------------------------------------------ fresh install: the four hub states
test('fresh install 1/4, no hub configured: every hook exits 0, prints nothing, writes nothing', () => {
  const { home, env } = mkEnv();
  const before = tree(home);
  for (const [script, input] of [['memory-check.mjs', startInput], ['correction-capture.mjs', prompt('No, I said stop doing that')]]) {
    const r = run(script, env, input);
    assert.equal(r.code, 0, script);
    assert.equal(r.out, '', script + ' must be silent without a hub');
    assert.equal(r.err, '', script);
  }
  assert.deepEqual(tree(home), before, 'nothing created in HOME');
  // session-start is unchanged: still the one-line nudge
  const s = run('session-start.mjs', env, startInput);
  assert.equal(s.code, 0);
  assert.match(s.out, /Not set up yet/);
});

test('fresh install 2/4, empty hub folder: silent, and the folder stays empty', () => {
  const { home, env } = mkEnv();
  const hub = path.join(home, 'empty-hub');
  fs.mkdirSync(hub);
  write(path.join(home, '.jarvis-hub-path'), hub + '\n'); // resolved through the pointer file
  for (const [script, input] of [['memory-check.mjs', startInput], ['correction-capture.mjs', prompt('Stop doing that, I told you')]]) {
    const r = run(script, env, input);
    assert.equal(r.code, 0, script);
    assert.equal(r.out, '', script);
  }
  assert.deepEqual(fs.readdirSync(hub), [], 'no stamp, no report in an empty hub');
});

test('fresh install 3/4, template hub: checker silent, memory untouched, correction fires in Hebrew and English', () => {
  const { home, env } = mkEnv();
  const hub = mkTemplateHub(home);
  const e = { ...env, JARVIS_HUB: hub };
  const before = snapshot(hub);

  const c = run('memory-check.mjs', e, startInput);
  assert.equal(c.code, 0);
  assert.equal(c.out, '', 'clean template hub: silence');
  assert.ok(fs.existsSync(path.join(hub, '.memory-check-stamp')));
  assert.equal(fs.existsSync(path.join(hub, 'reports')), false, 'no report when clean');

  for (const text of ['No, I said use tabs', 'לא, אמרתי שצריך טאבים']) {
    const r = run('correction-capture.mjs', e, prompt(text));
    assert.equal(r.code, 0);
    assert.match(r.out, /^\[jarvis-os\] If this corrects you: save ~\/jarvis-hub\/feedback_<slug>\.md/);
    assert.match(r.out, /violations/);
    assert.ok(Buffer.byteLength(r.out) <= 215, 'bytes ' + Buffer.byteLength(r.out));
  }
  assert.equal(run('correction-capture.mjs', e, prompt('Please add a README section')).out, '');
  assert.deepEqual(snapshot(hub), before, 'no hook edits memory');
});

function seeded() {
  const { home, env } = mkEnv();
  const hub = mkTemplateHub(home);
  write(path.join(hub, 'MEMORY.md'), fs.readFileSync(path.join(hub, 'MEMORY.md'), 'utf8').replace('## Reference', '- [Gone](gone-note.md) - dangling\n\n## Reference'));
  write(path.join(hub, 'project_old.md'), FM('  check: version node 99\n') + 'Deploy script: `/Users/nobody/deploy-' + process.pid + '.sh`\n');
  return { home, hub, env: { ...env, JARVIS_HUB: hub } };
}

test('fresh install 4/4, seeded hub: one line, report with every finding, memory untouched, throttled to 24h', () => {
  const { hub, env } = seeded();
  const before = snapshot(hub);
  const r = run('memory-check.mjs', { ...env, JARVIS_MEMORY_CHECK_TODAY: '2026-11-19' }, startInput);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.out.trim().split('\n').length, 1, 'exactly one line');
  const report = path.join(hub, 'reports', 'memory-check-2026-11-19.md');
  assert.equal(r.out.trim(), '[jarvis-os] memory check: 4 possibly-stale items → ' + report + ' (ask me to fix them)');
  const text = fs.readFileSync(report, 'utf8');
  assert.match(text, /deploy-\d+\.sh` does not exist/);
  assert.match(text, /link target `gone-note\.md` does not exist/);
  assert.match(text, /`project_old\.md` has no line in MEMORY\.md/);
  assert.match(text, /unknown verb "version"/);
  assert.match(text, /Nothing was changed/);
  assert.deepEqual(snapshot(hub), before, 'memory files are byte-identical');

  // throttle: a second session inside 24h is silent and does not rewrite the report
  const mt = fs.statSync(report).mtimeMs;
  const again = run('memory-check.mjs', env, startInput);
  assert.equal(again.out, '');
  assert.equal(fs.statSync(report).mtimeMs, mt);

  // 25 hours later it runs again
  const stamp = path.join(hub, '.memory-check-stamp');
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(stamp, old, old);
  assert.match(run('memory-check.mjs', env, startInput).out, /memory check: 4 possibly-stale items/);
});

test('checker: kill switches (env, <hub>/.memory-check.off) and --force', () => {
  const { hub, env } = seeded();
  assert.equal(run('memory-check.mjs', { ...env, JARVIS_MEMORY_CHECK: '0' }, startInput).out, '');
  write(path.join(hub, '.memory-check.off'), '');
  assert.equal(run('memory-check.mjs', env, startInput).out, '');
  assert.equal(fs.existsSync(path.join(hub, '.memory-check-stamp')), false, 'a disabled checker leaves no trace');
  fs.rmSync(path.join(hub, '.memory-check.off'));
  const r = spawnSync(process.execPath, [path.join(HOOKS, 'memory-check.mjs'), '--force'], { env, encoding: 'utf8' });
  assert.match(r.stdout, /memory check: 4 possibly-stale items/);
});

test('checker: unreadable hub or report dir never breaks the session (exit 0, no output)', () => {
  const { hub, env } = seeded();
  write(path.join(hub, 'reports'), 'a file where the report folder should be');
  const r = run('memory-check.mjs', env, startInput);
  assert.equal(r.code, 0);
  assert.equal(r.out, '', 'no report could be written, so no notice either');
  const bad = run('memory-check.mjs', { ...env, JARVIS_HUB: '/nonexistent/hub/xyz' }, startInput);
  assert.equal(bad.code, 0);
  assert.equal(bad.out, '');
});

test('checker: reports are pruned to the newest 14', () => {
  const { hub, env } = seeded();
  for (let d = 1; d <= 20; d++) write(path.join(hub, 'reports', 'memory-check-2026-10-' + String(d).padStart(2, '0') + '.md'), 'old');
  run('memory-check.mjs', { ...env, JARVIS_MEMORY_CHECK_TODAY: '2026-11-19' }, startInput);
  const left = fs.readdirSync(path.join(hub, 'reports')).sort();
  assert.equal(left.length, 14);
  assert.equal(left.at(-1), 'memory-check-2026-11-19.md');
});

// ------------------------------------------------------------------ correction hook behaviour
test('correction hook: cooldown, per session, default once every 4 prompts', () => {
  const { home, env } = mkEnv();
  const hub = mkTemplateHub(home);
  const e = { ...env, JARVIS_HUB: hub };
  const s = sid();
  const fired = [];
  for (let i = 1; i <= 9; i++) fired.push(run('correction-capture.mjs', e, prompt('no, I said stop', s)).out !== '');
  assert.deepEqual(fired, [true, false, false, false, true, false, false, false, true]);
  assert.equal(run('correction-capture.mjs', e, prompt('no, I said stop', sid())).out !== '', true, 'another session has its own cooldown');
  const e2 = { ...e, JARVIS_CORRECTION_COOLDOWN: '1' };
  const s2 = sid();
  assert.equal(run('correction-capture.mjs', e2, prompt('no, I said stop', s2)).out !== '', true);
  assert.equal(run('correction-capture.mjs', e2, prompt('no, I said stop', s2)).out !== '', true);
  // non-correction prompts count toward the cooldown window too
  const s3 = sid();
  assert.ok(run('correction-capture.mjs', e, prompt('stop doing that', s3)).out);
  for (let i = 0; i < 3; i++) run('correction-capture.mjs', e, prompt('please run the tests', s3));
  assert.ok(run('correction-capture.mjs', e, prompt('stop doing that', s3)).out, 'fires again 4 prompts later');
});

test('correction hook: kill switch (env and <hub>/.correction-capture.off)', () => {
  const { home, env } = mkEnv();
  const hub = mkTemplateHub(home);
  const e = { ...env, JARVIS_HUB: hub };
  assert.equal(run('correction-capture.mjs', { ...e, JARVIS_CORRECTION_CAPTURE: '0' }, prompt('no, I said stop')).out, '');
  write(path.join(hub, '.correction-capture.off'), '');
  assert.equal(run('correction-capture.mjs', e, prompt('no, I said stop')).out, '');
  fs.rmSync(path.join(hub, '.correction-capture.off'));
  assert.ok(run('correction-capture.mjs', e, prompt('no, I said stop')).out);
});

test('correction hook: Telegram channel prompts are unwrapped, other machine turns are skipped', () => {
  const { home, env } = mkEnv();
  const hub = mkTemplateHub(home);
  const e = { ...env, JARVIS_HUB: hub };
  const tg = (t) => '<channel source="plugin:telegram:telegram" chat_id="42" message_id="7" user="or" ts="2026-11-19T10:00:00Z">' + t + '</channel>';
  assert.ok(run('correction-capture.mjs', e, prompt(tg('no, I said keep it short'))).out);
  assert.ok(run('correction-capture.mjs', e, prompt(tg('אמרתי לך כבר, בלי אימוג׳ים'))).out);
  assert.equal(run('correction-capture.mjs', e, prompt(tg('what is the weather'))).out, '');
  assert.equal(run('correction-capture.mjs', e, prompt('<task-notification>no, I said stop</task-notification>')).out, '');
  assert.equal(run('correction-capture.mjs', e, prompt('<system-reminder>stop doing that</system-reminder>')).out, '');
});

test('correction hook: fails open on bad input (exit 0, silent, never exit 2)', () => {
  const { home, env } = mkEnv();
  const hub = mkTemplateHub(home);
  const e = { ...env, JARVIS_HUB: hub };
  for (const input of ['', 'not json', '{}', '{"prompt": 5}', '{"prompt": null}', '[]', 'null', '\u0000\u0001', JSON.stringify({ prompt: 'x'.repeat(300000) })]) {
    const r = run('correction-capture.mjs', e, input);
    assert.equal(r.code, 0, JSON.stringify(input.slice(0, 20)));
    assert.equal(r.out, '');
  }
  // an unwritable state dir only costs the cooldown, never the hook
  const r = run('correction-capture.mjs', { ...e, JARVIS_STATE_DIR: '/dev/null/x' }, prompt('no, I said stop'));
  assert.equal(r.code, 0);
  assert.ok(r.out);
});

// ------------------------------------------------------------------ speed
test('speed: p50 under 200ms per hook call (20 runs each, node process start included)', () => {
  const { home, env } = mkEnv();
  const hub = mkTemplateHub(home);
  const e = { ...env, JARVIS_HUB: hub };
  const stamp = path.join(hub, '.memory-check-stamp');
  const N = 20;
  const rows = {};
  const measure = (name, fn) => { const xs = []; for (let i = 0; i < N; i++) xs.push(fn(i)); rows[name] = xs; };

  measure('node startup only (baseline)', () => { const t = performance.now(); spawnSync(process.execPath, ['-e', '0'], { env }); return performance.now() - t; });
  measure('session-start (template hub)', () => run('session-start.mjs', e, startInput).ms);
  run('memory-check.mjs', e, startInput); // arm the stamp
  measure('memory-check, throttled (typical)', () => run('memory-check.mjs', e, startInput).ms);
  measure('memory-check, due, clean template', () => { fs.utimesSync(stamp, new Date(0), new Date(0)); return run('memory-check.mjs', e, startInput).ms; });
  const seededHub = seeded();
  measure('memory-check, due, seeded hub with findings', () => { fs.rmSync(path.join(seededHub.hub, '.memory-check-stamp'), { force: true }); return run('memory-check.mjs', seededHub.env, startInput).ms; });
  measure('correction-capture, no match', (i) => run('correction-capture.mjs', e, prompt('please add a README section', 'speed-nm-' + i)).ms);
  measure('correction-capture, match (EN)', (i) => run('correction-capture.mjs', e, prompt('no, I said use tabs', 'speed-en-' + i)).ms);
  measure('correction-capture, match (HE)', (i) => run('correction-capture.mjs', e, prompt('לא, אמרתי שצריך טאבים', 'speed-he-' + i)).ms);

  console.log('\n  hook timing, ms over ' + N + ' runs (wall time of the whole process, spawn included)');
  for (const [k, xs] of Object.entries(rows)) console.log('  ' + k.padEnd(48) + 'p50 ' + pct(xs, 0.5).toFixed(1).padStart(6) + '   p95 ' + pct(xs, 0.95).toFixed(1).padStart(6));
  for (const [k, xs] of Object.entries(rows)) assert.ok(pct(xs, 0.5) < 200, k + ' p50 ' + pct(xs, 0.5).toFixed(1) + 'ms');
});
