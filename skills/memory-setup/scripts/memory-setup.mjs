#!/usr/bin/env node
// jarvis-os: memory-setup. Builds the whole memory system for a fresh user, from zero.
//
//   node memory-setup.mjs [--lang he|en] [--dry-run] [--hub <dir>]
//
// What it does (every step creates only what is missing and never overwrites a user file):
//   1. a short always-on block in the user-level CLAUDE.md (marked block, the rest of the file is
//      kept byte for byte)
//   2. a knowledge-pack folder with README + index (<hub>/knowledge)
//   3. the auto-memory conventions (one fact per file + MEMORY.md index, violations: counter) and,
//      for a hub with no MEMORY.md, the seed files from memory-template/
//   4. raw/ (inbox) and wiki/ (curated), each with a short README, plus wiki/index.md
//   5. reports whether `qmd` is on PATH and prints the optional index command (never installs)
//   6. verifies the memory-check hook is wired and runs the checker once, read-only
//   7. verifies the correction-capture hook is wired and where its kill switch is
//
// Zero config: with no env and an empty home it uses ~/jarvis-hub and writes ~/.jarvis-hub-path.
// Idempotent: a second run changes nothing and says so. --dry-run writes nothing at all.
// Node stdlib only. Always exits 0: a setup helper that throws is worse than a plain message.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const BEGIN_RE = /<!-- shufi-memory:begin v\d+ -->/g;
const END = '<!-- shufi-memory:end -->';
const BLOCK_VERSION = 1;

// ---------------------------------------------------------------- strings (He + En in one table)
const T = {
  title: { en: 'Memory setup', he: 'הגדרת זיכרון' },
  hubLine: { en: 'Hub: {0} ({1})', he: 'תיקיית הזיכרון: {0} ({1})' },
  src_env: { en: 'from JARVIS_HUB', he: 'מתוך JARVIS_HUB' },
  src_pointer: { en: 'from ~/.jarvis-hub-path', he: 'מתוך ~/.jarvis-hub-path' },
  src_flag: { en: 'from --hub', he: 'מתוך --hub' },
  src_default: { en: 'default', he: 'ברירת מחדל' },
  dryRun: { en: 'DRY RUN: nothing is written.', he: 'הרצה יבשה: שום דבר לא נכתב.' },
  st_created: { en: 'created', he: 'נוצר' },
  st_updated: { en: 'updated', he: 'עודכן' },
  st_would_create: { en: 'would create', he: 'ייווצר' },
  st_would_update: { en: 'would update', he: 'יעודכן' },
  st_exists: { en: 'exists, left as is', he: 'קיים, לא שונה' },
  st_ok: { en: 'ok', he: 'תקין' },
  st_info: { en: 'info', he: 'מידע' },
  st_skipped: { en: 'skipped', he: 'דולג' },
  st_error: { en: 'error', he: 'שגיאה' },
  n_pointer: { en: 'so every session finds the hub', he: 'כדי שכל שיחה תמצא את התיקייה' },
  n_pointer_other: { en: 'points to {0}; left as is', he: 'מצביע ל-{0}; לא שונה' },
  n_env: { en: 'JARVIS_HUB is set; no pointer file needed', he: 'JARVIS_HUB מוגדר; אין צורך בקובץ מצביע' },
  n_template: { en: 'seed memory file', he: 'קובץ זיכרון התחלתי' },
  n_memory_exists: { en: 'your memory index; seed files not added', he: 'אינדקס הזיכרון שלך; קבצי התחלה לא נוספו' },
  n_block_new: { en: 'new file with the memory block', he: 'קובץ חדש עם בלוק הזיכרון' },
  n_block_add: { en: 'memory block added at the end; the rest is untouched (backup: {0})', he: 'בלוק הזיכרון נוסף בסוף; השאר לא שונה (גיבוי: {0})' },
  n_block_refresh: { en: 'memory block refreshed; the rest is untouched (backup: {0})', he: 'בלוק הזיכרון רוענן; השאר לא שונה (גיבוי: {0})' },
  n_block_current: { en: 'memory block is current', he: 'בלוק הזיכרון מעודכן' },
  n_block_broken: { en: 'markers are damaged or repeated; fix by hand, then run again', he: 'הסימונים פגומים או כפולים; תקן ידנית והרץ שוב' },
  n_qmd_yes: { en: 'qmd found (optional). To search the hub: qmd collection add {0} --name memory && qmd embed', he: 'qmd נמצא (אופציונלי). לחיפוש בתיקייה: qmd collection add {0} --name memory && qmd embed' },
  n_qmd_no: { en: 'qmd not found (optional). Get it: npm install -g @tobilu/qmd', he: 'qmd לא נמצא (אופציונלי). להתקנה: npm install -g @tobilu/qmd' },
  n_check_wired: { en: 'SessionStart hook wired (runs at most once a day)', he: 'הוק SessionStart מחובר (רץ לכל היותר פעם ביום)' },
  n_check_clean: { en: '; checked now: clean ({0} files)', he: '; נבדק עכשיו: נקי ({0} קבצים)' },
  n_check_found: { en: '; checked now: {0} possibly-stale items (run: node "{1}" --force)', he: '; נבדק עכשיו: {0} פריטים אולי ישנים (להרצה: node "{1}" --force)' },
  n_check_skipped: { en: '; not run now (dry run, hub not created yet)', he: '; לא הורץ עכשיו (הרצה יבשה, התיקייה עדיין לא נוצרה)' },
  n_check_off: { en: '; currently OFF ({0})', he: '; כרגע כבוי ({0})' },
  n_check_missing: { en: 'NOT wired in plugin.json or hook file missing', he: 'לא מחובר ב-plugin.json או שקובץ ההוק חסר' },
  n_corr_wired: { en: 'hook wired. Just correct me; say "undo" to remove the rule. Off: touch {0}', he: 'ההוק מחובר. פשוט תקן אותי; כתוב "undo" כדי למחוק את הכלל. כיבוי: touch {0}' },
  n_corr_off: { en: 'hook wired but currently OFF ({0})', he: 'ההוק מחובר אבל כרגע כבוי ({0})' },
  n_corr_missing: { en: 'NOT wired in plugin.json or hook file missing', he: 'לא מחובר ב-plugin.json או שקובץ ההוק חסר' },
  n_manifest_missing: { en: 'plugin.json not found next to this script; wiring not verified', he: 'plugin.json לא נמצא ליד הסקריפט; החיבור לא אומת' },
  nothing: { en: 'Nothing to do. Memory is already set up.', he: 'אין מה לעשות. הזיכרון כבר מוגדר.' },
  done: { en: 'Done: {0} created, {1} updated.', he: 'הסתיים: {0} נוצרו, {1} עודכנו.' },
  planned: { en: 'Plan: {0} to create, {1} to update. Run without --dry-run to apply.', he: 'תוכנית: {0} ייווצרו, {1} יעודכנו. הרץ בלי --dry-run כדי להחיל.' },
  nextStep: { en: 'Next: restart Claude Code (or start a new session). Then just work; say "done" when you finish.', he: 'הבא: הפעל מחדש את Claude Code (או פתח שיחה חדשה). אחר כך פשוט עבוד; כתוב "done" כשמסיימים.' },
  errors: { en: '{0} step(s) failed; the rest was applied. Run again after fixing the cause.', he: '{0} שלבים נכשלו; השאר הוחל. הרץ שוב אחרי תיקון הסיבה.' },
};

// Files seeded from text. Frontmatter keys stay English in both languages.
const FILES = {
  knowledgeReadme: {
    en: `---
name: knowledge-readme
description: How knowledge packs work in this hub
read-when: before adding or editing a knowledge pack
tier-key: not applicable (convention file)
---

# Knowledge packs

A pack is a folder of markdown about ONE subject, split so a task loads only the part it needs.

\`\`\`
knowledge/
  README.md              this file: the convention
  index.md               router: which pack answers which question. Read first.
  <subject>/index.md     the pack spine and routing table. Always read first.
  <subject>/NN-<topic>.md   one file per sub-topic, numbered, loaded on demand
\`\`\`

## Rules for every pack file

- Frontmatter: \`name\`, \`description\`, \`read-when\` (a concrete trigger: "before choosing X"), \`tier-key\`.
- Every claim carries a source URL and an evidence tier. A = primary source or standard,
  B = repeated practitioner consensus, C = a single unsourced claim.
- Numbers over adjectives. Never invent a number: a widely repeated but unsourceable statistic is
  recorded as folklore.
- Say where the evidence is thin. Flag contradictions between sources; do not average them.

## Add a pack

Create \`<subject>/index.md\` with the frontmatter above, then add one row to \`index.md\`.
A skill points at a pack; it never copies from one.
`,
    he: `---
name: knowledge-readme
description: איך חבילות ידע עובדות בתיקייה הזו
read-when: before adding or editing a knowledge pack
tier-key: not applicable (convention file)
---

# חבילות ידע

חבילה היא תיקיית markdown על נושא אחד, מחולקת כך שמשימה טוענת רק את החלק שהיא צריכה.

\`\`\`
knowledge/
  README.md              הקובץ הזה: המוסכמה
  index.md               נתב: איזו חבילה עונה על איזו שאלה. קוראים ראשון.
  <subject>/index.md     עמוד השדרה של החבילה וטבלת ניתוב. תמיד נקרא ראשון.
  <subject>/NN-<topic>.md   קובץ לכל תת-נושא, ממוספר, נטען לפי דרישה
\`\`\`

## כללים לכל קובץ בחבילה

- פרונטמטר: \`name\`, \`description\`, \`read-when\` (טריגר מוחשי: "לפני בחירת X"), \`tier-key\`.
- כל טענה נושאת כתובת מקור ודרגת ראיה. A = מקור ראשוני או תקן, B = קונצנזוס חוזר של מתרגלים,
  C = טענה בודדת בלי מקור.
- מספרים במקום תארים. אף פעם לא להמציא מספר: נתון נפוץ שאי אפשר למצוא לו מקור נרשם כפולקלור.
- לציין איפה הראיות דלות. סתירות בין מקורות מסמנים, לא עושים ממוצע.

## הוספת חבילה

יוצרים \`<subject>/index.md\` עם הפרונטמטר למעלה, ומוסיפים שורה אחת ל-\`index.md\`.
סקיל מצביע על חבילה; הוא אף פעם לא מעתיק ממנה.
`,
  },
  knowledgeIndex: {
    en: `---
name: knowledge-index
description: Router for the knowledge packs: which pack answers which question
read-when: before researching, designing or writing about a subject that may already have a pack
tier-key: not applicable (router)
---

# Knowledge packs: router

Read the pack's \`index.md\` first; it routes to the specific file. Convention: \`README.md\`.

| Pack | Read it when | Entry |
|---|---|---|
| **memory-conventions** | writing or editing a memory file, a feedback rule or a patterns record | \`memory-conventions.md\` |

Add a row here for every new pack. Keep "Read it when" concrete.
`,
    he: `---
name: knowledge-index
description: נתב לחבילות הידע: איזו חבילה עונה על איזו שאלה
read-when: before researching, designing or writing about a subject that may already have a pack
tier-key: not applicable (router)
---

# חבילות ידע: נתב

קוראים קודם את \`index.md\` של החבילה; הוא מנתב לקובץ הספציפי. המוסכמה: \`README.md\`.

| חבילה | קוראים כש | כניסה |
|---|---|---|
| **memory-conventions** | כותבים או עורכים קובץ זיכרון, כלל משוב או רשומת patterns | \`memory-conventions.md\` |

מוסיפים שורה כאן לכל חבילה חדשה. "קוראים כש" צריך להיות מוחשי.
`,
  },
  memoryConventions: {
    en: `---
name: memory-conventions
description: How memory files, the MEMORY.md index and feedback rules are written in this hub
read-when: before writing or editing a memory file, a feedback rule or a patterns.md record
tier-key: not applicable (the plugin's own conventions)
---

# Memory conventions

- **One fact per file.** A file is \`<type>_<slug>.md\` with frontmatter \`name\`, \`description\`
  (one line, specific enough to match later) and \`metadata.type\`: user, project, feedback or reference.
- **One index line per file** in \`MEMORY.md\`, under its type: \`- [Title](file.md) - one-sentence hook\`.
  The index is injected into every session, so keep it lean. Update the line in the same edit as the file.
- **Feedback rule** (\`feedback_<slug>.md\`): the rule, then \`**Why:**\` and \`**How to apply:**\`.
  Frontmatter carries \`violations: 0\`. When the user corrects the same rule again, add 1 to
  \`violations\` and refine the text; never write a second file for the same rule. A rising number means
  the rule sits in the wrong place (prose instead of a hook). "Undo" deletes the file and its index line.
- **patterns.md record**: \`status\`, \`count\`, optional \`violations\`, \`first\`, \`last\`, \`review\`, \`claim\`,
  \`action\`, \`evidence\` (the newest 3 lines, the user's own words). Full format:
  \`skills/memory-consolidation/references/record-format.md\` in the plugin.
- **Stale facts.** A path, a version or "X is broken" was true the day it was written. Check before
  you rely on it. Fix with a dated note ("moved to X, checked YYYY-MM-DD"); keep the history.
  An optional \`check:\` line in the frontmatter (\`exists <path>\`, \`absent <path>\`, \`grep <path> <text>\`)
  lets the daily memory check verify a fact.
- **Where things go.** Unsorted captures: \`raw/\`. Curated, sourced notes: \`wiki/\`. Subject packs: \`knowledge/\`.
`,
    he: `---
name: memory-conventions
description: איך כותבים קבצי זיכרון, את אינדקס MEMORY.md וכללי משוב בתיקייה הזו
read-when: before writing or editing a memory file, a feedback rule or a patterns.md record
tier-key: not applicable (the plugin's own conventions)
---

# מוסכמות זיכרון

- **עובדה אחת לקובץ.** קובץ נקרא \`<type>_<slug>.md\` עם פרונטמטר \`name\`, \`description\`
  (שורה אחת, ספציפית מספיק כדי להתאים אחר כך) ו-\`metadata.type\`: user, project, feedback או reference.
- **שורת אינדקס אחת לקובץ** ב-\`MEMORY.md\`, תחת הסוג שלו: \`- [Title](file.md) - משפט אחד\`.
  האינדקס נטען לכל שיחה, אז שומרים אותו רזה. מעדכנים את השורה באותה עריכה עם הקובץ.
- **כלל משוב** (\`feedback_<slug>.md\`): הכלל, ואז \`**Why:**\` ו-\`**How to apply:**\`.
  בפרונטמטר \`violations: 0\`. כשהמשתמש מתקן שוב את אותו כלל, מוסיפים 1 ל-\`violations\` ומחדדים את
  הטקסט; לא כותבים קובץ שני לאותו כלל. מספר שעולה אומר שהכלל במקום הלא נכון (פרוזה במקום הוק).
  "undo" מוחק את הקובץ ואת שורת האינדקס שלו.
- **רשומה ב-patterns.md**: \`status\`, \`count\`, \`violations\` (אופציונלי), \`first\`, \`last\`, \`review\`,
  \`claim\`, \`action\`, \`evidence\` (3 השורות החדשות, במילים של המשתמש). הפורמט המלא:
  \`skills/memory-consolidation/references/record-format.md\` בתוסף.
- **עובדות ישנות.** נתיב, גרסה או "X שבור" היו נכונים ביום שנכתבו. בודקים לפני שנשענים עליהם.
  מתקנים בהערה מתוארכת ("הועבר ל-X, נבדק YYYY-MM-DD"); שומרים את ההיסטוריה. שורת \`check:\` אופציונלית
  בפרונטמטר (\`exists <path>\`, \`absent <path>\`, \`grep <path> <text>\`) נותנת לבדיקה היומית לאמת עובדה.
- **לאן מה הולך.** קליטות לא ממוינות: \`raw/\`. הערות מסוכמות עם מקורות: \`wiki/\`. חבילות נושא: \`knowledge/\`.
`,
  },
  rawReadme: {
    en: `# raw/: the inbox

Drop anything unsorted here: a pasted article, a transcript, a quick capture. Nothing in this folder
is trusted or curated. When something is worth keeping, write it up in \`../wiki/\` (short, with
sources), then delete the raw copy or note where it went.
`,
    he: `# raw/: תיבת הדואר הנכנס

זורקים לכאן כל דבר לא ממוין: מאמר שהודבק, תמלול, קליטה מהירה. שום דבר בתיקייה הזו לא נחשב אמין
או מסוכם. כשמשהו שווה לשמור, כותבים אותו ב-\`../wiki/\` (קצר, עם מקורות), ואז מוחקים את העותק הגולמי
או רושמים לאן הוא עבר.
`,
  },
  wikiReadme: {
    en: `# wiki/: curated notes

One short article per topic (about 200 to 400 words), written once and kept current. Each article
starts with frontmatter listing its sources. Look here before searching or asking the web: a
compiled note is cheaper than rediscovering the same thing. Raw material lives in \`../raw/\`; the
index is \`index.md\`: add one line per article.
`,
    he: `# wiki/: הערות מסוכמות

מאמר קצר אחד לנושא (בערך 200 עד 400 מילים), נכתב פעם אחת ומתעדכן. כל מאמר פותח בפרונטמטר עם
המקורות שלו. מסתכלים כאן לפני חיפוש או גלישה: הערה מסוכמת זולה יותר מלגלות שוב את אותו הדבר.
חומר גולמי נמצא ב-\`../raw/\`; האינדקס הוא \`index.md\`: מוסיפים שורה אחת לכל מאמר.
`,
  },
  wikiIndex: {
    en: `# Wiki index

One line per article: \`- [Title](path.md) - what it answers\`.

(no articles yet)
`,
    he: `# אינדקס הוויקי

שורה אחת לכל מאמר: \`- [Title](path.md) - על מה הוא עונה\`.

(אין מאמרים עדיין)
`,
  },
};

// Used only when memory-template/ cannot be found (a skill copied out of the plugin).
const FALLBACK_MEMORY = {
  en: '# Memory Index\n\n_One line per memory: `- [Title](file.md) - one-sentence hook`. The fact itself lives in the linked file._\n\n## User\n\n## Project\n\n## Feedback\n\n## Reference\n',
  he: '# Memory Index\n\n_שורה אחת לכל זיכרון: `- [Title](file.md) - משפט אחד`. העובדה עצמה יושבת בקובץ המקושר._\n\n## User\n\n## Project\n\n## Feedback\n\n## Reference\n',
};

// The always-on block. English only on purpose: it is an instruction to the model, and keeping it
// identical in every language means a run in another language never "updates" it.
export function buildBlock(hub) {
  return [
    `<!-- shufi-memory:begin v${BLOCK_VERSION} -->`,
    '## Memory',
    `- Hub: ${hub} (MEMORY.md loads at start). MUST read ${path.join(hub, 'knowledge', 'index.md')} before a task on a subject; check ${path.join(hub, 'wiki', 'index.md')} before web search.`,
    '- User corrects you: save one feedback rule in the hub (repeat: violations +1); "undo" deletes it.',
    '- Remembered paths, versions and "X is broken" may be stale: verify first.',
    END,
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------- helpers
const fmt = (s, ...a) => s.replace(/\{(\d)\}/g, (_, i) => String(a[+i] ?? ''));

function parseArgs(argv, env) {
  const o = { dry: false, lang: null, hub: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dry = true;
    else if (a === '--lang') o.lang = argv[++i];
    else if (a.startsWith('--lang=')) o.lang = a.slice(7);
    else if (a === '--hub') o.hub = argv[++i];
    else if (a.startsWith('--hub=')) o.hub = a.slice(6);
  }
  const fromEnv = (env.JARVIS_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || '').toLowerCase();
  const guess = fromEnv.startsWith('he') || fromEnv.startsWith('iw') ? 'he' : 'en';
  const l = String(o.lang || '').toLowerCase();
  o.lang = l === 'he' || l === 'en' ? l : guess;
  return o;
}

function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

function readPointer(home) {
  try {
    const f = path.join(home, '.jarvis-hub-path');
    if (fs.lstatSync(f).isFile()) return fs.readFileSync(f, 'utf8').trim() || null;
  } catch (e) { /* none */ }
  return null;
}

// Same order as the session-start hook (JARVIS_HUB, then the pointer file), plus --hub first and
// the documented default last.
export function pickHub({ flag, env, home }) {
  if (flag) return { hub: path.resolve(expandHome(flag, home)), source: 'flag' };
  const e = (env.JARVIS_HUB || '').trim();
  if (e) return { hub: expandHome(e, home), source: 'env' };
  const p = readPointer(home);
  if (p) return { hub: expandHome(p, home), source: 'pointer' };
  return { hub: path.join(home, 'jarvis-hub'), source: 'default' };
}

const exists = (p) => { try { fs.lstatSync(p); return true; } catch (e) { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

function onPath(cmd, env) {
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) for (const x of exts) {
    try { fs.accessSync(path.join(d, cmd + x), fs.constants.X_OK); if (isFile(path.join(d, cmd + x))) return true; } catch (e) { /* next */ }
  }
  return false;
}

function findPluginRoot(env) {
  const cands = [];
  if (env.CLAUDE_PLUGIN_ROOT) cands.push(env.CLAUDE_PLUGIN_ROOT);
  cands.push(path.resolve(SELF_DIR, '..', '..', '..'));
  for (const c of cands) if (isFile(path.join(c, '.claude-plugin', 'plugin.json'))) return c;
  for (const c of cands) if (exists(path.join(c, 'memory-template'))) return c;
  return null;
}

function listFiles(dir) {
  const out = [];
  (function w(d, rel) {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) w(p, path.join(rel, n)); else out.push(path.join(rel, n));
    }
  })(dir, '');
  return out;
}

// ---------------------------------------------------------------- the CLAUDE.md block
// Returns { action: 'create'|'update'|'unchanged'|'broken', next: Buffer|null, existed }
export function planBlock(existing, block) {
  if (existing === null) return { action: 'create', next: Buffer.from(block, 'utf8') };
  const begins = [];
  const text = existing.toString('latin1'); // ASCII markers; byte offsets stay aligned
  const newer = /<!-- shufi-memory:begin v(\d+) -->/.exec(text);
  if (newer && Number(newer[1]) > BLOCK_VERSION) return { action: 'unchanged', next: null }; // written by a newer plugin
  BEGIN_RE.lastIndex = 0;
  let m;
  while ((m = BEGIN_RE.exec(text))) begins.push(m.index);
  const ends = [];
  for (let i = text.indexOf(END); i >= 0; i = text.indexOf(END, i + 1)) ends.push(i);
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const mine = Buffer.from(eol === '\n' ? block : block.replace(/\n/g, eol), 'utf8');

  if (begins.length === 0 && ends.length === 0) {
    let tail = '';
    if (existing.length && !text.endsWith('\n')) tail += eol;
    if (existing.length) tail += eol;
    return { action: 'update', next: Buffer.concat([existing, Buffer.from(tail, 'latin1'), mine]), appended: true };
  }
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) return { action: 'broken', next: null };
  // The block runs to the end marker and one trailing line break (if present).
  let stop = ends[0] + END.length;
  if (text.startsWith('\r\n', stop)) stop += 2; else if (text[stop] === '\n') stop += 1;
  const cur = existing.subarray(begins[0], stop);
  const norm = (b) => b.toString('utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (norm(cur) === norm(mine)) return { action: 'unchanged', next: null };
  const hadEol = stop > ends[0] + END.length;
  const repl = hadEol ? mine : mine.subarray(0, mine.length - eol.length);
  return { action: 'update', next: Buffer.concat([existing.subarray(0, begins[0]), repl, existing.subarray(stop)]) };
}

// ---------------------------------------------------------------- main
export async function run({ argv = process.argv.slice(2), env = process.env, home = os.homedir(), out = (s) => process.stdout.write(s + '\n') } = {}) {
  const opt = parseArgs(argv, env);
  const L = opt.lang;
  const t = (k, ...a) => fmt(T[k][L], ...a);
  const dry = opt.dry;
  const short = (p) => (p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);
  const { hub, source } = pickHub({ flag: opt.hub, env, home });
  const root = findPluginRoot(env);
  const rows = []; // { status, what, note }
  const add = (status, what, note = '') => rows.push({ status, what: short(what), note });
  let errors = 0;

  const guard = (what, fn) => {
    try { fn(); } catch (e) { errors++; add('error', what, String((e && e.message) || e).slice(0, 160)); }
  };

  // Create a file only if it is missing ('wx' refuses to overwrite even in a race).
  const seedFile = (file, content, note) => guard(file, () => {
    if (exists(file)) return add('exists', file);
    if (dry) return add('would_create', file, note);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, content, { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') return add('exists', file); throw e; }
    add('created', file, note);
  });

  // 0. pointer file, so the SessionStart hook finds a hub that was chosen by default or --hub
  const pointer = path.join(home, '.jarvis-hub-path');
  if (source === 'env') add('ok', pointer, t('n_env'));
  else if (source === 'pointer') add('exists', pointer);
  else {
    const cur = readPointer(home);
    if (cur && path.resolve(expandHome(cur, home)) !== hub) add('exists', pointer, t('n_pointer_other', short(cur)));
    else if (cur) add('exists', pointer);
    else seedFile(pointer, hub + '\n', t('n_pointer'));
  }

  // 1. memory index + seed files (only for a hub that has no MEMORY.md yet)
  const memoryFile = path.join(hub, 'MEMORY.md');
  if (exists(memoryFile)) {
    add('exists', memoryFile, t('n_memory_exists'));
  } else {
    const tpl = root && exists(path.join(root, 'memory-template')) ? path.join(root, 'memory-template') : null;
    if (tpl) {
      guard(tpl, () => { for (const rel of listFiles(tpl)) seedFile(path.join(hub, rel), fs.readFileSync(path.join(tpl, rel), 'utf8'), t('n_template')); });
    } else {
      seedFile(memoryFile, FALLBACK_MEMORY[L], t('n_template'));
    }
  }

  // 2 to 4. knowledge pack, wiki, raw
  seedFile(path.join(hub, 'knowledge', 'README.md'), FILES.knowledgeReadme[L]);
  seedFile(path.join(hub, 'knowledge', 'index.md'), FILES.knowledgeIndex[L]);
  seedFile(path.join(hub, 'knowledge', 'memory-conventions.md'), FILES.memoryConventions[L]);
  seedFile(path.join(hub, 'raw', 'README.md'), FILES.rawReadme[L]);
  seedFile(path.join(hub, 'wiki', 'README.md'), FILES.wikiReadme[L]);
  seedFile(path.join(hub, 'wiki', 'index.md'), FILES.wikiIndex[L]);

  // 5. the user-level CLAUDE.md block
  const cfgDir = (env.CLAUDE_CONFIG_DIR || '').trim() ? expandHome(env.CLAUDE_CONFIG_DIR.trim(), home) : path.join(home, '.claude');
  const claudeMd = path.join(cfgDir, 'CLAUDE.md');
  guard(claudeMd, () => {
    let existing = null;
    try { existing = fs.readFileSync(claudeMd); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const plan = planBlock(existing, buildBlock(hub));
    const backup = claudeMd + '.shufi-bak';
    if (plan.action === 'unchanged') return add('ok', claudeMd, t('n_block_current'));
    if (plan.action === 'broken') return add('skipped', claudeMd, t('n_block_broken'));
    if (plan.action === 'create') {
      if (dry) return add('would_create', claudeMd, t('n_block_new'));
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(claudeMd, plan.next);
      return add('created', claudeMd, t('n_block_new'));
    }
    const note = t(plan.appended ? 'n_block_add' : 'n_block_refresh', short(backup));
    if (dry) return add('would_update', claudeMd, note);
    if (!exists(backup)) fs.writeFileSync(backup, existing, { flag: 'wx' });
    fs.writeFileSync(claudeMd, plan.next);
    add('updated', claudeMd, note);
  });

  // 6. qmd (detect only; never installs anything)
  add('info', 'qmd', onPath('qmd', env) ? t('n_qmd_yes', hub) : t('n_qmd_no'));

  // 7. the two shipped hooks: wired in plugin.json? checker run once, read-only
  const wired = (event, script) => {
    try {
      if (!root) return null;
      const m = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
      const groups = (m.hooks && m.hooks[event]) || [];
      const hit = groups.some((g) => (g.hooks || []).some((h) => String(h.command || '').includes(script)));
      return hit && isFile(path.join(root, 'hooks', script));
    } catch (e) { return null; }
  };
  const envOff = (name) => ['0', 'off', 'false'].includes((env[name] || '').trim().toLowerCase());

  const chk = wired('SessionStart', 'memory-check.mjs');
  const chkOff = path.join(hub, '.memory-check.off');
  if (chk === null) add('info', 'memory-check', t('n_manifest_missing'));
  else if (!chk) add('error', 'memory-check', t('n_check_missing'));
  else {
    let note = t('n_check_wired');
    if (envOff('JARVIS_MEMORY_CHECK') || exists(chkOff)) note += t('n_check_off', exists(chkOff) ? short(chkOff) : 'JARVIS_MEMORY_CHECK=0');
    else if (!isFile(memoryFile)) note += t('n_check_skipped');
    else {
      try {
        const core = await import(pathToFileURL(path.join(root, 'hooks', 'lib', 'memory-check-core.mjs')).href);
        const res = core.checkMemory({ hub, home, today: core.localDate(), budgetMs: 1500, startedAt: performance.now() });
        note += res.findings.length
          ? t('n_check_found', res.findings.length, path.join(root, 'hooks', 'memory-check.mjs'))
          : t('n_check_clean', res.stats.files);
      } catch (e) { note += ' (' + String(e.message).slice(0, 80) + ')'; }
    }
    add('ok', 'memory-check', note);
  }

  const cor = wired('UserPromptSubmit', 'correction-capture.mjs');
  const corOff = path.join(hub, '.correction-capture.off');
  if (cor === null) add('info', 'correction-capture', t('n_manifest_missing'));
  else if (!cor) add('error', 'correction-capture', t('n_corr_missing'));
  else if (envOff('JARVIS_CORRECTION_CAPTURE') || exists(corOff)) add('ok', 'correction-capture', t('n_corr_off', exists(corOff) ? short(corOff) : 'JARVIS_CORRECTION_CAPTURE=0'));
  else add('ok', 'correction-capture', t('n_corr_wired', short(corOff)));

  // ------------------------------------------------------------ report
  const label = (s) => t('st_' + s);
  const width = Math.max(...rows.map((r) => label(r.status).length));
  const created = rows.filter((r) => r.status === 'created').length;
  const updated = rows.filter((r) => r.status === 'updated').length;
  const wc = rows.filter((r) => r.status === 'would_create').length;
  const wu = rows.filter((r) => r.status === 'would_update').length;
  const lines = [];
  lines.push(`${t('title')}: ${t('hubLine', short(hub), t('src_' + source))}`);
  if (dry) lines.push(t('dryRun'));
  for (const r of rows) lines.push(`  ${label(r.status).padEnd(width)}  ${r.what}${r.note ? '  - ' + r.note : ''}`);
  if (errors) lines.push(t('errors', errors));
  if (dry) lines.push(wc + wu === 0 && !errors ? t('nothing') : t('planned', wc, wu));
  else if (created + updated === 0 && !errors) lines.push(t('nothing'));
  else { lines.push(t('done', created, updated)); lines.push(t('nextStep')); }
  out(lines.join('\n'));
  return { rows, created, updated, errors, hub };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try { await run(); } catch (e) { process.stdout.write('memory-setup: ' + String((e && e.message) || e) + '\n'); }
  process.exit(0);
}
