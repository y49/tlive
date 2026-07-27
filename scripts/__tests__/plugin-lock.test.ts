// The bundled plugin carries its own version line, independent of the npm
// package version (release-please owns that one). Three files have to move
// together — both vendors' plugin.json plus plugins/.content-lock.json — and
// getting it wrong ships a stale cache to users, so the bump is a single
// scripted operation rather than three hand edits.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain .mjs helper shared with the consistency test
import { nextVersion, bumpPlugins, computePluginContentHash, readPluginVersions, readLock } from '../plugin-lock.mjs';

const CLAUDE_REL = 'plugins/claude/plugins/tlive/.claude-plugin/plugin.json';
const CODEX_REL = 'plugins/codex/plugins/tlive/.codex-plugin/plugin.json';

// Mirrors the real files, em-dash escape included: a naive JSON round-trip
// would rewrite — as a literal character and churn the content hash.
const claudeJson = (v: string) =>
  `{\n  "name": "tlive",\n  "version": "${v}",\n  "description": "tlive hooks \\u2014 IM approvals"\n}\n`;
const codexJson = (v: string) =>
  `{\n  "name": "tlive",\n  "version": "${v}",\n  "description": "tlive skill \\u2014 session monitoring"\n}\n`;

let root: string;

function seed(version: string) {
  for (const rel of [CLAUDE_REL, CODEX_REL]) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
  }
  writeFileSync(join(root, CLAUDE_REL), claudeJson(version));
  writeFileSync(join(root, CODEX_REL), codexJson(version));
  writeFileSync(
    join(root, 'plugins', '.content-lock.json'),
    JSON.stringify({ version, hash: computePluginContentHash(root) }, null, 2) + '\n',
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tlive-plugin-lock-'));
  seed('2.5.3');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('nextVersion', () => {
  it('bumps each semver position', () => {
    expect(nextVersion('2.5.3', 'patch')).toBe('2.5.4');
    expect(nextVersion('2.5.3', 'minor')).toBe('2.6.0');
    expect(nextVersion('2.5.3', 'major')).toBe('3.0.0');
  });

  it('accepts an explicit version', () => {
    expect(nextVersion('2.5.3', '3.1.4')).toBe('3.1.4');
  });

  it('rejects anything else', () => {
    expect(() => nextVersion('2.5.3', 'sideways')).toThrow(/patch\|minor\|major/);
  });
});

describe('bumpPlugins', () => {
  it('moves both vendors and the lock in one step', () => {
    const result = bumpPlugins('minor', root);

    expect(result).toEqual({ from: '2.5.3', to: '2.6.0' });
    expect(readPluginVersions(root)).toEqual({ claude: '2.6.0', codex: '2.6.0' });
    expect(readLock(root).version).toBe('2.6.0');
  });

  it('leaves the lock hash matching the post-bump content', () => {
    bumpPlugins('patch', root);

    expect(readLock(root).hash).toBe(computePluginContentHash(root));
  });

  it('rewrites only the version line, preserving escapes and formatting', () => {
    bumpPlugins('patch', root);

    expect(readFileSync(join(root, CLAUDE_REL), 'utf-8')).toBe(claudeJson('2.5.4'));
    expect(readFileSync(join(root, CODEX_REL), 'utf-8')).toBe(codexJson('2.5.4'));
  });

  it('refuses to bump when the two vendors have drifted apart', () => {
    writeFileSync(join(root, CODEX_REL), codexJson('2.5.2'));

    expect(() => bumpPlugins('patch', root)).toThrow(/lockstep/);
  });
});
