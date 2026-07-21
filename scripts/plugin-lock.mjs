// scripts/plugin-lock.mjs
//
// Content lock for the bundled plugins (plugins/**). The consistency test
// (plugin-consistency.test.ts) recomputes the hash and fails when plugin
// content changes without a version bump + lock refresh — that is what
// keeps "changed the plugin but forgot to bump" from silently shipping a
// stale cache to users (the 2.0.0 stuck-cache incident class).
//
// Refresh after bumping both plugin.json versions:
//   node scripts/plugin-lock.mjs --update

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK_PATH = join(REPO_ROOT, 'plugins', '.content-lock.json');
const LOCK_BASENAME = '.content-lock.json';

function walk(dir, files = []) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === LOCK_BASENAME) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else files.push(p);
  }
  return files;
}

/** sha256 over every file under plugins/ (sorted relative path + content). */
export function computePluginContentHash(root = REPO_ROOT) {
  const pluginsDir = join(root, 'plugins');
  const h = createHash('sha256');
  for (const f of walk(pluginsDir)) {
    h.update(relative(pluginsDir, f).split('\\').join('/'));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

export function readPluginVersions(root = REPO_ROOT) {
  const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf-8')).version;
  return {
    claude: read('plugins/claude/plugins/tlive/.claude-plugin/plugin.json'),
    codex: read('plugins/codex/plugins/tlive/.codex-plugin/plugin.json'),
  };
}

export function readLock(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, 'plugins', LOCK_BASENAME), 'utf-8'));
}

if (process.argv[2] === '--update') {
  const versions = readPluginVersions();
  if (versions.claude !== versions.codex) {
    console.error(`plugin versions out of lockstep: claude ${versions.claude} vs codex ${versions.codex} — align them first`);
    process.exit(1);
  }
  const lock = { version: versions.claude, hash: computePluginContentHash() };
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');
  console.log(`plugins/.content-lock.json updated: version ${lock.version}, hash ${lock.hash.slice(0, 12)}…`);
}
