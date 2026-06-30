import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveLabel, gitBranch } from '../run';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tlive-run-')); });

describe('gitBranch', () => {
  it('returns null when not a git repo', () => {
    expect(gitBranch(dir)).toBeNull();
  });
  it('parses branch from .git/HEAD', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
    expect(gitBranch(dir)).toBe('feat/x');
  });
});

describe('deriveLabel', () => {
  it('is "<cmd> @ <basename>" without git', () => {
    expect(deriveLabel('claude', '/home/u/proj')).toBe('claude @ proj');
  });
  it('appends the git branch when present', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(deriveLabel('codex', dir)).toBe(`codex @ ${join(dir).split('/').filter(Boolean).pop()} (main)`);
  });
});
