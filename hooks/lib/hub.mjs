// shufi: hub resolution shared by the memory-check and correction-capture hooks.
// Same order as session-start.mjs: JARVIS_HUB, then the ~/.jarvis-hub-path pointer file.
// Returns null when no hub is configured. Never throws.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandHome(p, home = os.homedir()) {
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

export function resolveHub(env = process.env, home = os.homedir()) {
  try {
    const fromEnv = (env.JARVIS_HUB || '').trim();
    if (fromEnv) return expandHome(fromEnv, home);
    const pointer = path.join(home, '.jarvis-hub-path');
    if (fs.lstatSync(pointer).isFile()) {
      const raw = fs.readFileSync(pointer, 'utf8').trim();
      if (raw) return expandHome(raw, home);
    }
  } catch (e) { /* not configured */ }
  return null;
}

// A hub counts as set up when it has a MEMORY.md. An empty or missing folder gets
// no checks and no rule capture: session-start already tells the user to set up.
export function hubIsSetUp(hub) {
  try { return !!hub && fs.statSync(path.join(hub, 'MEMORY.md')).isFile(); } catch (e) { return false; }
}

export function exists(p) {
  try { fs.lstatSync(p); return true; } catch (e) { return false; }
}
