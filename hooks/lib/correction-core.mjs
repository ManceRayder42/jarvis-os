// jarvis-os: correction detection, pure part (Hebrew and English). No I/O.
//
//   unwrapPrompt(raw)  -> the text to analyse, or null to skip the prompt
//   detectCorrection(text) -> { kind: 'strong' | 'weak', term } | null
//
// Precision over recall: a false fire costs ~80 tokens, a missed one costs nothing but one retyped
// correction. So:
//   - STRONG phrases ("no, I said", "I told you", "don't ever", "stop doing", "wrong again",
//     "לא אמרתי", "אמרתי לך", "תפסיק", "שוב טעית") fire on their own;
//   - WEAK words (always, never, תמיד, אף פעם, לעולם) fire only inside a directive: "you never",
//     "always use ...", "תמיד תשתמש ...", never in a question, never in a long paste, never as
//     "I always ..." (a statement about the user, not an instruction to Claude).

const HE_PREFIX = new Set('והבכלמש');
const NIQQUD = /[֑-ׇ]/g;
const HE_TOKEN = /[א-ת]+/g;
const MAX_ANALYSED = 600; // longer prompts are pastes (logs, code, articles): scan the head, strong terms only

// ------------------------------------------------------------------ input
const CHANNEL_BLOCK = /<channel\b[^>]*>([\s\S]*?)<\/channel>/g;
const CHANNEL_TAG = /<\/?channel\b[^>]*>/g;

// Telegram prompts arrive as <channel source="plugin:telegram:..." ...>text</channel>. Unwrap that
// one tag; every other prompt that starts with "<" is a machine turn and is skipped. Slash
// commands are skipped too.
export function unwrapPrompt(raw) {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (!p) return null;
  if (p.startsWith('<channel source="plugin:telegram')) {
    const blocks = [...p.matchAll(CHANNEL_BLOCK)].map((m) => m[1].trim()).filter(Boolean);
    const text = blocks.length ? blocks.join('\n') : p.replace(CHANNEL_TAG, '').trim();
    return text || null;
  }
  if (p.startsWith('<') || p.startsWith('/')) return null;
  return p;
}

// ------------------------------------------------------------------ English
const EN_STRONG = [
  /\bno[,.!;:\s]+(?:i|we)\s+(?:said|told|asked|meant|wrote)\b/,
  /\bi(?:'ve|\s+have)?(?:\s+already)?\s+(?:told|asked)\s+you\b/,
  /\bas\s+i\s+(?:said|told|mentioned|asked)\b/,
  /\bdon'?t\s+(?:you\s+)?ever\b/,
  /\bdo\s+not\s+ever\b/,
  /\bnever\s+again\b/,
  /\bstop\s+[a-z]+ing\b/,
  /\bwrong\s+again\b/,
  /\bsame\s+(?:mistake|error)\s+again\b/,
  /\byou\s+(?:did|made|got|broke)\s+(?:it|that|this|the\s+same\s+\w+)\s+(?:wrong\s+)?again\b/,
  /\bnot\s+what\s+i\s+(?:asked|said|meant|wanted|told)\b/,
  /\bhow\s+many\s+times\s+(?:do|must|should|have|did|will)\s+i\b/,
  /\bi\s+keep\s+(?:telling|saying)\b/,
  /\byou\s+keep\s+[a-z]+ing\b/,
  /\bfrom\s+now\s+on\b/,
];
const EN_WEAK = /\b(always|never)\b/g;
const EN_SELF = new Set(['i', 'we', 'he', 'she', 'they', 'it', 'there', 'who', 'that', 'which', 'you\'ve']);
const EN_DIRECTIVE_VERB = new Set(['use', 'do', 'add', 'run', 'write', 'ask', 'check', 'make', 'call', 'put', 'create',
  'keep', 'show', 'include', 'give', 'answer', 'reply', 'respond', 'format', 'commit', 'push', 'delete', 'touch',
  'change', 'edit', 'explain', 'start', 'end', 'say', 'assume', 'forget', 'skip', 'leave', 'wait', 'tell', 'read',
  'test', 'verify', 'summarize', 'summarise', 'send', 'open', 'save', 'name', 'prefer', 'default', 'remove', 'overwrite']);

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
// when what is left equals the term exactly: "שאמרתי" matches "אמרתי", "לאמר" does not.
const HE_STRONG = [
  ['לא', 'אמרתי'], ['אמרתי', 'לך'], ['כבר', 'אמרתי'], ['אמרתי', 'כבר'], ['ביקשתי', 'ממך'], ['לא', 'ביקשתי'],
  ['תפסיק'], ['תפסיקו'], ['תפסיקי'], ['כמה', 'פעמים', 'אמרתי'], ['כמה', 'פעמים', 'ביקשתי'], ['כמה', 'פעמים', 'צריך', 'להגיד'], ['כמה', 'פעמים', 'צריך', 'לבקש'], ['מעכשיו'], ['בפעם', 'הבאה'], ['טעית'], ['אסור', 'לך'],
  ['לא', 'ככה'], ['זה', 'לא', 'מה', 'שביקשתי'], ['זה', 'לא', 'מה', 'שאמרתי'], ['זה', 'לא', 'מה', 'שרציתי'],
];
const HE_WEAK = [['תמיד'], ['אף', 'פעם'], ['לעולם'], ['כל', 'פעם']];
const HE_NOT_DIRECTIVE = new Set(['תדאג', 'תדאגי', 'תחשוש', 'תשכח', 'תטרח', 'תודה', 'תודות', 'תמיד', 'תמונה']);
const HE_YOU = new Set(['אתה', 'אתם', 'את', 'אתן']);

function tokenMatchesAt(tokens, i, term, allowPrefix) {
  const first = term[0];
  const tok = tokens[i];
  if (tok !== first) {
    if (!allowPrefix || !tok.endsWith(first)) return false;
    const pre = tok.slice(0, tok.length - first.length);
    if (pre.length < 1 || pre.length > 3 || ![...pre].every((c) => HE_PREFIX.has(c))) return false;
  }
  for (let k = 1; k < term.length; k++) if (tokens[i + k] !== term[k]) return false;
  return true;
}

function findTerm(tokens, terms) {
  for (const term of terms) {
    for (let i = 0; i + term.length <= tokens.length; i++) {
      if (tokenMatchesAt(tokens, i, term, true)) return { term, at: i };
    }
  }
  return null;
}

function heStrong(tokens) {
  const hit = findTerm(tokens, HE_STRONG);
  if (hit) return hit.term.join(' ');
  for (let i = 0; i < tokens.length; i++) {
    const nx = tokens[i + 1] || '';
    // "אל תעשה": אל + a verb starting with ת. Exact token, no prefix ("שאל תמר" is not a command).
    if (tokens[i] === 'אל' && /^ת[א-ת]{2,}$/.test(nx) && !HE_NOT_DIRECTIVE.has(nx)) return 'אל ' + nx;
    // "שוב עשית / שוב שכחת": again + a second-person past verb (ends in ת).
    if (tokenMatchesAt(tokens, i, ['שוב'], true) && /^[א-ת]{3,}ת$/.test(nx)) return 'שוב ' + nx;
  }
  return null;
}

function heWeak(tokens) {
  const hit = findTerm(tokens, HE_WEAK);
  if (!hit) return null;
  const prev = tokens[hit.at - 1] || '';
  const next = tokens[hit.at + hit.term.length] || '';
  const imperative = /^ת[א-ת]{3,}$/.test(next) && !HE_NOT_DIRECTIVE.has(next);
  const infinitive = /^ל[א-ת]{3,}$/.test(next);
  if (HE_YOU.has(prev) || imperative || infinitive || next === 'אל') return hit.term.join(' ');
  return null;
}

// ------------------------------------------------------------------ main
export function detectCorrection(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const full = raw.replace(/[‘’]/g, "'");
  const text = full.slice(0, MAX_ANALYSED);
  const t = text.toLowerCase();
  const tokens = text.replace(NIQQUD, '').match(HE_TOKEN) || [];

  for (const re of EN_STRONG) { const m = re.exec(t); if (m) return { kind: 'strong', term: m[0].trim() }; }
  const hs = heStrong(tokens);
  if (hs) return { kind: 'strong', term: hs };

  if (full.length > MAX_ANALYSED || text.includes('?') || text.includes('؟')) return null; // weak terms: short statements only
  const ew = enWeak(t);
  if (ew) return { kind: 'weak', term: ew };
  const hw = heWeak(tokens);
  if (hw) return { kind: 'weak', term: hw };
  return null;
}

// The injected instruction. Built from constants and the hub path only: no prompt text, no memory
// text, so nothing a user pasted can ride along into the context.
export function buildInstruction(hub, home = '') {
  const shown = home && (hub === home || hub.startsWith(home + '/')) ? '~' + hub.slice(home.length) : hub;
  return '[jarvis-os] If this corrects you, save a rule now: ' + shown + '/feedback_<slug>.md ' +
    '(name, description, metadata type: feedback, violations: 0; body: rule, Why, How to apply) ' +
    '+ index line in MEMORY.md. Rule exists? violations +1. ' +
    'Reply in my language: Saved as a rule: <rule> (say \'undo\' to remove).\n';
}
