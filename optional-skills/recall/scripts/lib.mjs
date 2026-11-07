// jarvis-os session-recall: shared helpers (hub resolution, opt-in check,
// secret redaction, transcript parsing). No dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// JARVIS_HUB -> ~/.jarvis-hub-path -> null (same order as the rest of the plugin).
export function resolveHub() {
  const fromEnv = process.env.JARVIS_HUB;
  if (fromEnv && fromEnv.trim()) return expandHome(fromEnv.trim());
  try {
    const pointer = path.join(os.homedir(), '.jarvis-hub-path');
    if (fs.lstatSync(pointer).isFile()) {
      const raw = fs.readFileSync(pointer, 'utf8').trim();
      if (raw) return expandHome(raw);
    }
  } catch (e) { /* not configured */ }
  return null;
}

// Opt-in: JARVIS_SESSION_RECALL=1 turns it on, =0 forces it off; otherwise a
// flag file <hub>/.session-recall turns it on.
export function isOptedIn(hub) {
  const env = (process.env.JARVIS_SESSION_RECALL || '').trim();
  if (env === '0' || env.toLowerCase() === 'false') return false;
  if (env === '1' || env.toLowerCase() === 'true') return true;
  try {
    return fs.lstatSync(path.join(hub, '.session-recall')).isFile();
  } catch (e) {
    return false;
  }
}

export function stagingDir(hub) {
  return path.join(hub, 'staging', 'session-notes');
}

export function claudeProjectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR ? expandHome(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

// Claude Code names a project's transcript folder after its cwd with every
// non-alphanumeric character replaced by "-".
export function projectDirFor(cwd) {
  return path.join(claudeProjectsDir(), String(cwd).replace(/[^A-Za-z0-9]/g, '-'));
}

// Session ids are used in file names: keep only safe characters.
export function safeId(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

const SECRET_RES = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /bearer\s+[A-Za-z0-9._-]{20,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(api[_-]?key|secret|token|password|passwd|pwd|auth[_-]?token|ct0)\b\s*[:=]\s*['"]?[^\s'",;]{8,}/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

export function redact(text) {
  let t = String(text);
  for (const rx of SECRET_RES) t = t.replace(rx, '[REDACTED]');
  return t;
}

export function clip(text, n) {
  const t = String(text).trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

export function blocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter((b) => b && typeof b === 'object') : [];
}

export function isNoise(text) {
  const t = String(text).trimStart();
  return !t || ['<system-reminder>', '<task-notification>', '<command-name>', '<local-command', 'Caveat:', '[Request interrupted']
    .some((p) => t.startsWith(p));
}

// Yield parsed JSON rows from a .jsonl file, skipping unparsable lines.
export function* readJsonl(file) {
  const data = fs.readFileSync(file, 'utf8');
  for (const line of data.split('\n')) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch (e) { /* skip */ }
  }
}
