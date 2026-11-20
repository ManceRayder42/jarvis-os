// shufi: correction detection, pure part (Hebrew and English). No I/O.
//
//   unwrapPrompt(raw)  -> the text to analyse, or null to skip the prompt
//   detectCorrection(text) -> { kind: 'strong' | 'weak', term } | null
//
// Precision over recall: a false fire costs ~80 tokens, a missed one costs nothing but one retyped
// correction. So:
//   - STRONG phrases ("no, I said", "I told you", "don't ever", "stop doing that", "wrong again",
//     "לא אמרתי", "אמרתי לך", "תפסיק", "שוב טעית") fire on their own;
//   - "I told/asked you" and "אמרתי לך / ביקשתי ממך" are corrections only when the clause STARTS
//     there ("I asked you to X. Not Y."). Inside a relative clause they refer back to an earlier
//     request and are quiet: "the folder that I asked you to", "הפירוט שביקשתי ממך";
//   - a plain negative imperative ("אל תשנה כלום", "stop opening tabs") is a new instruction, not a
//     correction, and fires only next to a correction marker (לא, שוב, כבר, again, please, "I repeat");
//   - WEAK words (always, never, תמיד, אף פעם, לעולם) fire only inside a directive in a short
//     message: "you never", "always use ...", "תמיד תשתמש ...", never in a question, never as
//     "I always ..." or "you can always ...".
//   - Only the user's own words are read: <pasted_content> blocks are cut out first.
// Tuned against a replay of 1760 real prompts: see test/fixtures/correction-fixtures.json.

const HE_PREFIX = new Set('והבכלמש');
const NIQQUD = /[֑-ׇ]/g;
const HE_TOKEN = /[א-ת]+/g;
const MAX_ANALYSED = 600; // longer prompts are pastes (logs, code, articles): scan the head only
const MAX_WEAK = 200;     // weak terms: short statements only

// ------------------------------------------------------------------ input
const CHANNEL_BLOCK = /<channel\b[^>]*>([\s\S]*?)<\/channel>/g;
const CHANNEL_TAG = /<\/?channel\b[^>]*>/g;

// Telegram prompts arrive as <channel source="plugin:telegram:..." ...>text</channel>. Unwrap that
// one tag; every other prompt that starts with "<" is a machine turn and is skipped. Slash
// commands are skipped too.
const PASTED = /<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content>|$)/g;
export const stripPasted = (s) => s.replace(PASTED, ' ');

export function unwrapPrompt(raw) {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (!p) return null;
  if (p.startsWith('<channel source="plugin:telegram')) {
    const blocks = [...p.matchAll(CHANNEL_BLOCK)].map((m) => m[1].trim()).filter(Boolean);
    const text = blocks.length ? blocks.join('\n') : p.replace(CHANNEL_TAG, '').trim();
    return stripPasted(text).trim() || null;
  }
  if (p.startsWith('<') || p.startsWith('/')) return null;
  return stripPasted(p).trim() || null;
}

// ------------------------------------------------------------------ English
const EN_STRONG = [
  /\bno[,.!;:\s]+(?:i|we)\s+(?:said|told|asked|meant|wrote)\b/,
  /\b(?:as|like)\s+i\s+(?:said|told|mentioned|asked)\b/,
  /\bdon'?t\s+(?:you\s+)?ever\b/,
  /\bdo\s+not\s+ever\b/,
  /\bnever\s+again\b/,
  /\bstop\s+(?:doing\s+(?:that|this|it)|that|it|this)\b/,
  /\bwrong\s+again\b/,
  /\bsame\s+(?:mistake|error)\s+again\b/,
  /\byou\s+(?:did|made|got|broke)\s+(?:it|that|this|the\s+same\s+\w+)\s+(?:wrong\s+)?again\b/,
  /\bnot\s+what\s+i\s+(?:asked|said|meant|wanted|want|told)\b/,
  /\bhow\s+many\s+times\s+(?:do|must|should|have|did|will)\s+i\b/,
  /\bi\s+keep\s+(?:telling|saying)\b/,
  /\byou\s+keep\s+[a-z]+ing\b/,
  /\bfrom\s+now\s+on\b/,
];
const EN_WEAK = /\b(always|never)\b/g;
const EN_SELF = new Set(['i', 'we', 'he', 'she', 'they', 'it', 'there', 'who', 'that', 'which', 'you\'ve',
  'can', 'could', 'may', 'might', 'will', 'would', "'ll"]); // 'I always ...' and 'you can always ...' are not instructions
const EN_DIRECTIVE_VERB = new Set(['use', 'do', 'add', 'run', 'write', 'ask', 'check', 'make', 'call', 'put', 'create',
  'keep', 'show', 'include', 'give', 'answer', 'reply', 'respond', 'format', 'commit', 'push', 'delete', 'touch',
  'change', 'edit', 'explain', 'start', 'end', 'say', 'assume', 'forget', 'skip', 'leave', 'wait', 'tell', 'read',
  'test', 'verify', 'summarize', 'summarise', 'send', 'open', 'save', 'name', 'prefer', 'default', 'remove', 'overwrite']);

// "I told/asked you" is a correction only when the clause starts there. Anything else ("the folder
// that I asked you to", "what I told you", "the codeword I told you") points back to a request.
const TOLD = /\bi(?:'ve|\s+have)?(?:\s+already)?\s+(?:told|asked)\s+you\b/g;
const CLAUSE_LEAD = new Set(['and', 'but', 'so', 'no', 'yes', 'okay', 'ok', 'now', 'well', 'because', 'cause', 'since',
  'like', 'as', 'still', 'also', 'then', 'plus', 'hey', 'look', 'listen', 'honestly', 'seriously', 'actually']);
function enToldYou(t) {
  for (const m of t.matchAll(TOLD)) {
    const before = t.slice(0, m.index).replace(/[ \t]+$/, '');
    const prev = (before.match(/([a-z']+)\W*$/) || [])[1] || '';
    if (before === '' || /[.!?\n:;,]$/.test(before) || CLAUSE_LEAD.has(prev)) return m[0];
  }
  return null;
}

// "stop <verb>ing" is an instruction unless something marks it as a complaint: "please stop
// pressing", "can you stop ...", "again", "I repeat".
const STOP_ING = /\bstop\s+[a-z]+ing\b/g;
const STOP_MARK = /\b(?:please|again|already|repeat|enough|told you|asked you|i said|every time|annoying)\b/;
function enStop(t) {
  for (const m of t.matchAll(STOP_ING)) {
    const prev = (t.slice(0, m.index).match(/([a-z']+)\W*$/) || [])[1] || '';
    if (prev === 'please' || prev === 'you' || prev === 'just' || STOP_MARK.test(t)) return m[0];
  }
  return null;
}

function enWeak(t) {
  EN_WEAK.lastIndex = 0;
  let m;
  while ((m = EN_WEAK.exec(t))) {
    const before = t.slice(0, m.index).match(/([a-z']+)\W*$/);
    const after = t.slice(m.index + m[0].length).match(/^\W*([a-z']+)/);
    const prev = before ? before[1] : '';
    const next = after ? after[1] : '';
    if (EN_SELF.has(prev)) continue;               // "I always ...": about the user
    if (prev === 'you' || prev === 'please' || EN_DIRECTIVE_VERB.has(next)) return m[1];
  }
  return null;
}

// ------------------------------------------------------------------ Hebrew
// Phrases are token lists. The FIRST token may carry 1-3 prefix letters from ו ה ב כ ל מ ש, and only
// when what is left equals the term exactly: "לאמר" is not "אמרתי". Exception: terms with אמרתי or
// ביקשתי take only the prefix ו ("ואמרתי לך"), because ש/כ/מ/ל make them a relative clause that points
// back at an old request: "הפירוט שביקשתי ממך" is a reference, not a complaint.
const HE_STRONG = [
  ['לא', 'אמרתי'], ['אמרתי', 'לך'], ['כבר', 'אמרתי'], ['אמרתי', 'כבר'], ['ביקשתי', 'ממך'], ['לא', 'ביקשתי'],
  ['תפסיק'], ['תפסיקו'], ['תפסיקי'], ['כמה', 'פעמים', 'אמרתי'], ['כמה', 'פעמים', 'ביקשתי'], ['כמה', 'פעמים', 'צריך', 'להגיד'], ['כמה', 'פעמים', 'צריך', 'לבקש'], ['מעכשיו'], ['בפעם', 'הבאה'], ['טעית'], ['אסור', 'לך'],
  ['לא', 'ככה'], ['זה', 'לא', 'מה', 'שביקשתי'], ['זה', 'לא', 'מה', 'שאמרתי'], ['זה', 'לא', 'מה', 'שרציתי'],
];
const HE_SENTENCE_START = new Set(['לא ככה']); // "לא ככה." alone is a correction; "...לא ככה על הבעלה" inside a dictated spec is not
const HE_WEAK = [['תמיד'], ['אף', 'פעם'], ['לעולם'], ['כל', 'פעם']];
const HE_NOT_DIRECTIVE = new Set(['תדאג', 'תדאגי', 'תחשוש', 'תשכח', 'תטרח', 'תודה', 'תודות', 'תמיד', 'תמונה']);
const HE_YOU = new Set(['אתה', 'אתם', 'את', 'אתן']);
const HE_MARKER = new Set(['שוב', 'כבר', 'אמרתי', 'ביקשתי', 'פעמים']);
const ONLY_VAV = new Set('ו');

function hebrewTokens(text) {
  const clean = text.replace(NIQQUD, '');
  const words = [];
  const starts = [];
  for (const m of clean.matchAll(HE_TOKEN)) {
    const before = clean.slice(0, m.index).replace(/[ \t]+$/, '');
    words.push(m[0]);
    starts.push(before === '' || /[.!?\n:;]$/.test(before));
  }
  return { words, starts };
}

function tokenMatchesAt(tokens, i, term, prefixes) {
  const first = term[0];
  const tok = tokens[i];
  if (tok !== first) {
    if (!prefixes || !tok.endsWith(first)) return false;
    const pre = tok.slice(0, tok.length - first.length);
    if (pre.length < 1 || pre.length > 3 || ![...pre].every((c) => prefixes.has(c))) return false;
  }
  for (let k = 1; k < term.length; k++) if (tokens[i + k] !== term[k]) return false;
  return true;
}

function findTerm(tokens, terms, starts) {
  for (const term of terms) {
    const prefixes = term.some((w) => /אמרתי|ביקשתי/.test(w)) ? ONLY_VAV : HE_PREFIX;
    const needStart = HE_SENTENCE_START.has(term.join(' '));
    for (let i = 0; i + term.length <= tokens.length; i++) {
      if (needStart && !(starts && starts[i])) continue;
      if (tokenMatchesAt(tokens, i, term, prefixes)) return { term, at: i };
    }
  }
  return null;
}

// A negative imperative is a correction only with a marker next to it: לא right before ("לא, אל תשנה"),
// or שוב / כבר / עוד פעם / אמרתי / ביקשתי / פעמים / "לא אהבתי" within a few words.
function heNearMarker(ws, i) {
  if (ws[i - 1] === 'לא') return true;
  for (let k = Math.max(0, i - 7); k < Math.min(ws.length, i + 4); k++) {
    if (k === i) continue;
    if (HE_MARKER.has(ws[k])) return true;
    if (ws[k] === 'עוד' && ws[k + 1] === 'פעם') return true;
    if (ws[k] === 'לא' && (ws[k + 1] === 'אהבתי' || ws[k + 1] === 'אוהב')) return true;
  }
  return false;
}

function heStrong({ words, starts }) {
  const hit = findTerm(words, HE_STRONG, starts);
  if (hit) return hit.term.join(' ');
  for (let i = 0; i < words.length; i++) {
    const nx = words[i + 1] || '';
    // "אל תעשה": אל + a verb starting with ת. Exact token ("שאל תמר" is not a command), ו allowed.
    if ((words[i] === 'אל' || words[i] === 'ואל') && /^ת[א-ת]{2,}$/.test(nx) && !HE_NOT_DIRECTIVE.has(nx) && heNearMarker(words, i)) return 'אל ' + nx;
    // "שוב עשית / שוב שכחת": again + a second-person past verb (ends in ת, not an infinitive like לעשות).
    if (tokenMatchesAt(words, i, ['שוב'], HE_PREFIX) && /^[^ל][א-ת]{2,}ת$/.test(nx)) return 'שוב ' + nx;
  }
  return null;
}

function heWeak({ words }) {
  const hit = findTerm(words, HE_WEAK);
  if (!hit) return null;
  const prev = words[hit.at - 1] || '';
  const next = words[hit.at + hit.term.length] || '';
  const imperative = /^ת[א-ת]{3,}$/.test(next) && !HE_NOT_DIRECTIVE.has(next);
  const infinitive = /^ל[א-ת]{3,}$/.test(next);
  if (HE_YOU.has(prev) || imperative || infinitive || next === 'אל') return hit.term.join(' ');
  return null;
}

// ------------------------------------------------------------------ main
export function detectCorrection(raw) {
  if (typeof raw !== 'string') return null;
  const full = stripPasted(raw).replace(/[\u2018\u2019]/g, "'");
  if (!full.trim()) return null;
  const text = full.slice(0, MAX_ANALYSED);
  const t = text.toLowerCase();
  const he = hebrewTokens(text);

  for (const re of EN_STRONG) { const m = re.exec(t); if (m) return { kind: 'strong', term: m[0].trim() }; }
  const told = enToldYou(t);
  if (told) return { kind: 'strong', term: told };
  const stop = enStop(t);
  if (stop) return { kind: 'strong', term: stop };
  const hs = heStrong(he);
  if (hs) return { kind: 'strong', term: hs };

  if (full.length > MAX_WEAK || text.includes('?') || text.includes('\u061F')) return null; // weak terms: short statements only
  const ew = enWeak(t);
  if (ew) return { kind: 'weak', term: ew };
  const hw = heWeak(he);
  if (hw) return { kind: 'weak', term: hw };
  return null;
}

// The injected instruction. Built from constants and the hub path only: no prompt text, no memory
// text, so nothing a user pasted can ride along into the context.
export function buildInstruction(hub, home = '') {
  const shown = home && (hub === home || hub.startsWith(home + '/')) ? '~' + hub.slice(home.length) : hub;
  return '[shufi] If this corrects you: save ' + shown + '/feedback_<slug>.md ' +
    '(type: feedback, violations: 0; Why; How to apply) + index line. Exists? violations +1. ' +
    'Reply: Saved as a rule: <rule> (say \'undo\' to remove).\n';
}
