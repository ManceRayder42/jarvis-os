#!/usr/bin/env node
// setup/skills-materializer.mjs — moves a skill between optional-skills/<id>
// and skills/<id> so Claude Code actually loads or unloads it. This is the
// implementation the contract comment above materializeSkill() in
// setup/server.mjs calls into (that file dynamically imports this one; see
// its comment for the exact signature this was written to satisfy).
//
// Mechanism: a symlink, not a literal move. Verified against the real
// Claude Code plugin/skill loader (CLI 2.1.261, 2026-09-05), not assumed:
//
//   1. `claude --plugin-dir <dir> -p "..."` with a symlinked skill directory
//      inside <dir>/skills/ -- the symlinked skill appeared in the raw
//      available-skills system-reminder listing, verbatim, alongside a
//      normal (non-symlinked) control skill in the same directory.
//   2. The real install path (`claude plugin marketplace add` + `claude
//      plugin install`) does NOT preserve a symlink that's already sitting
//      in the plugin source when it copies files into
//      ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ -- it's
//      silently dropped. Irrelevant here: nothing in this repo ships a
//      symlink IN git, this script creates one at RUNTIME, after install,
//      directly inside the plugin directory that's already on disk.
//   3. To confirm that's the scenario that actually matters: a symlink
//      created directly inside an ALREADY-INSTALLED plugin's cache
//      directory (exactly what this script does) was picked up by a plain
//      `claude -p` session with no special flags -- the skill loader scans
//      whatever's on disk at session start, it doesn't replay the install
//      copy step.
//
// A literal move would also satisfy the observable contract (server.mjs's
// handleSkillsList() only checks fs.existsSync(skills/<id>), which follows
// symlinks) but is strictly worse: it destroys the fixed location
// skills-catalog.json's `url` field and this repo's docs point at, and makes
// "disable" a move-it-back operation that can partially fail and leave a
// skill in neither directory. A symlink's failure modes are simpler — it
// either exists or it doesn't.
//
// The one thing a symlink can't do that a copy can: exist on a filesystem
// that refuses symlinks outright (e.g. Windows without Developer Mode or
// admin rights). Falls back to a real recursive copy there, marked with a
// sentinel file so disable() knows it's safe to delete.
//
// CLI (for terminal users who aren't running the setup page):
//   node setup/skills-materializer.mjs enable <skill-id | obsidian>
//   node setup/skills-materializer.mjs disable <skill-id | obsidian>
//   node setup/skills-materializer.mjs status [skill-id ...]
// `obsidian` expands to all three Obsidian skills as a convenience — it's
// not a real skill id, just a shorthand for typing three commands.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COPY_MARKER = '.optional-skill-copy';

// Known-good skill ids, loaded once. This is the "validate against the
// catalog rather than trusting it as a path segment" requirement from the
// contract -- and it's not theoretical. Without it:
//   setSkillEnabled(pluginRoot, '../../evil-target', true)
// resolves src/dest via plain path.join() to
//   <parent-of-pluginRoot>/evil-target
// i.e. a symlink written OUTSIDE the plugin entirely (confirmed by tracing
// path.join's own output -- '..' is not sandboxed by join()). A skillId is
// only ever a bare catalog id (lowercase, hyphens, no slashes), so
// requiring exact membership in skills-catalog.json closes this off
// completely: every legitimate id passes unchanged, nothing else reaches
// path.join at all.
const CATALOG_IDS = (() => {
  try {
    const catalogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills-catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    return new Set(catalog.skills.map((s) => s.id));
  } catch {
    // Missing/unparseable catalog -- fail closed (empty set rejects every
    // id) rather than silently skipping validation.
    return new Set();
  }
})();

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Move skillId between <pluginRoot>/optional-skills/<skillId> and
 * <pluginRoot>/skills/<skillId>. Never throws.
 *
 * @param {string} pluginRoot
 * @param {string} skillId
 * @param {boolean} enabled
 * @returns {Promise<{ok: boolean, action: 'enabled'|'disabled'|'already-enabled'|'already-disabled'|'not-found'|'error', error?: string}>}
 */
export async function setSkillEnabled(pluginRoot, skillId, enabled) {
  if (!CATALOG_IDS.has(skillId)) {
    return { ok: false, action: 'error', error: `unknown skill id (not in skills-catalog.json): ${skillId}` };
  }

  const src = path.join(pluginRoot, 'optional-skills', skillId);
  const dest = path.join(pluginRoot, 'skills', skillId);

  try {
    let destStat;
    try {
      destStat = fs.lstatSync(dest);
    } catch {
      destStat = null;
    }

    if (enabled) {
      if (destStat) {
        if (destStat.isSymbolicLink()) {
          const resolved = path.resolve(path.dirname(dest), fs.readlinkSync(dest));
          if (resolved === path.resolve(src)) return { ok: true, action: 'already-enabled' };
          return { ok: false, action: 'error', error: `skills/${skillId} is a symlink pointing elsewhere (${resolved})` };
        }
        if (fs.existsSync(path.join(dest, COPY_MARKER))) {
          return { ok: true, action: 'already-enabled' };
        }
        return { ok: false, action: 'error', error: `skills/${skillId} already exists and isn't managed by this materializer` };
      }
      if (!fs.existsSync(src)) return { ok: false, action: 'not-found' };

      try {
        const rel = path.relative(path.dirname(dest), src);
        fs.symlinkSync(rel, dest, 'dir');
        return { ok: true, action: 'enabled' };
      } catch (symlinkErr) {
        try {
          copyDirSync(src, dest);
          fs.writeFileSync(
            path.join(dest, COPY_MARKER),
            `Materialized copy managed by setup/skills-materializer.mjs (symlinks unavailable: ${symlinkErr.message}).\nEdit optional-skills/${skillId} instead, then re-run enable to refresh this copy.\n`,
          );
          return { ok: true, action: 'enabled' };
        } catch (copyErr) {
          return { ok: false, action: 'error', error: copyErr.message };
        }
      }
    } else {
      if (!destStat) {
        if (!fs.existsSync(src)) return { ok: false, action: 'not-found' };
        return { ok: true, action: 'already-disabled' };
      }
      if (destStat.isSymbolicLink()) {
        fs.unlinkSync(dest);
        return { ok: true, action: 'disabled' };
      }
      if (fs.existsSync(path.join(dest, COPY_MARKER))) {
        fs.rmSync(dest, { recursive: true, force: true });
        return { ok: true, action: 'disabled' };
      }
      return { ok: false, action: 'error', error: `skills/${skillId} exists and isn't managed by this materializer — refusing to delete it` };
    }
  } catch (e) {
    return { ok: false, action: 'error', error: e.message };
  }
}

// ---- CLI --------------------------------------------------------------
const OBSIDIAN_GROUP = ['obsidian-cli', 'obsidian-markdown', 'obsidian-bases', 'json-canvas'];

const isMain = (() => {
  try {
    return import.meta.url === `file://${path.resolve(process.argv[1] || '')}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const [, , cmd, ...rawIds] = process.argv;
  const expand = (id) => (id === 'obsidian' ? OBSIDIAN_GROUP : [id]);

  if (cmd === 'enable' || cmd === 'disable') {
    if (rawIds.length === 0) {
      console.log(`usage: node setup/skills-materializer.mjs ${cmd} <skill-id | obsidian>`);
      process.exit(2);
    }
    for (const id of rawIds.flatMap(expand)) {
      const r = await setSkillEnabled(PLUGIN_ROOT, id, cmd === 'enable');
      console.log(`${id}: ${r.action}${r.error ? ` — ${r.error}` : ''}`);
    }
  } else if (cmd === 'status') {
    const optionalDir = path.join(PLUGIN_ROOT, 'optional-skills');
    const ids = rawIds.length
      ? rawIds.flatMap(expand)
      : fs.existsSync(optionalDir)
        ? fs.readdirSync(optionalDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : [];
    for (const id of ids) {
      const dest = path.join(PLUGIN_ROOT, 'skills', id);
      let state = 'disabled';
      try {
        const st = fs.lstatSync(dest);
        state = st.isSymbolicLink() || fs.existsSync(path.join(dest, COPY_MARKER))
          ? 'enabled'
          : 'blocked (an unmanaged directory of the same name is already there)';
      } catch {
        // stays 'disabled'
      }
      console.log(`${id}: ${state}`);
    }
  } else {
    console.log('usage: node setup/skills-materializer.mjs <enable|disable|status> [skill-id | obsidian ...]');
    process.exit(cmd ? 2 : 0);
  }
}
