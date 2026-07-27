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

const PLUGIN_JSON = {
  claude: 'plugins/claude/plugins/tlive/.claude-plugin/plugin.json',
  codex: 'plugins/codex/plugins/tlive/.codex-plugin/plugin.json',
};

export function readPluginVersions(root = REPO_ROOT) {
  const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf-8')).version;
  return { claude: read(PLUGIN_JSON.claude), codex: read(PLUGIN_JSON.codex) };
}

export function readLock(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, 'plugins', LOCK_BASENAME), 'utf-8'));
}

/** Resolve a bump spec — patch/minor/major, or an explicit x.y.z — against `current`. */
export function nextVersion(current, spec) {
  if (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(spec)) return spec;
  const [major, minor, patch] = current.split('.').map(Number);
  if (spec === 'major') return `${major + 1}.0.0`;
  if (spec === 'minor') return `${major}.${minor + 1}.0`;
  if (spec === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump spec "${spec}" — expected patch|minor|major or an explicit x.y.z`);
}

/** Rewrite the lock from whatever is currently on disk. */
function writeLock(root) {
  const versions = readPluginVersions(root);
  if (versions.claude !== versions.codex) {
    throw new Error(
      `plugin versions out of lockstep: claude ${versions.claude} vs codex ${versions.codex} — align them first`,
    );
  }
  const lock = { version: versions.claude, hash: computePluginContentHash(root) };
  writeFileSync(join(root, 'plugins', LOCK_BASENAME), JSON.stringify(lock, null, 2) + '\n');
  return lock;
}

/**
 * Move both vendors' plugin.json and the content lock to the next version in
 * one step. The version line is patched in place rather than round-tripped
 * through JSON.parse/stringify: the shipped files carry — escapes that a
 * re-serialise would flatten into literal em-dashes, churning the content hash
 * for no reason.
 */
export function bumpPlugins(spec, root = REPO_ROOT) {
  const versions = readPluginVersions(root);
  if (versions.claude !== versions.codex) {
    throw new Error(
      `plugin versions out of lockstep: claude ${versions.claude} vs codex ${versions.codex} — align them first`,
    );
  }
  const from = versions.claude;
  const to = nextVersion(from, spec);

  for (const rel of Object.values(PLUGIN_JSON)) {
    const path = join(root, rel);
    const before = readFileSync(path, 'utf-8');
    const after = before.replace(/("version"\s*:\s*")[^"]*(")/, `$1${to}$2`);
    if (after === before) throw new Error(`no version field to rewrite in ${rel}`);
    writeFileSync(path, after);
  }

  writeLock(root); // hash must cover the just-written plugin.json files
  return { from, to };
}

const mode = process.argv[2];
if (mode === '--update') {
  try {
    const lock = writeLock(REPO_ROOT);
    console.log(`plugins/.content-lock.json updated: version ${lock.version}, hash ${lock.hash.slice(0, 12)}…`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else if (mode === '--bump') {
  try {
    const { from, to } = bumpPlugins(process.argv[3] ?? 'patch', REPO_ROOT);
    console.log(`bundled plugin ${from} → ${to} (both vendors + content lock)`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
