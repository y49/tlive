import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorktree, removeWorktree, listWorktrees } from '../../src/core/worktreeManager.js';

describe('worktreeManager', () => {
  const testDir = join(tmpdir(), `tlive-wt-test-${Date.now()}`);
  const repoDir = join(testDir, 'repo');

  beforeEach(() => {
    mkdirSync(repoDir, { recursive: true });
    execSync('git init && git commit --allow-empty -m "init"', { cwd: repoDir, stdio: 'pipe' });
  });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('creates a worktree with branch', () => {
    const wt = createWorktree(repoDir, 'test-feat');
    expect(wt.branch).toBe('tlive/test-feat');
    expect(wt.path).toContain('repo-worktrees/test-feat');
    expect(listWorktrees(repoDir).length).toBe(2);
  });

  it('removes a worktree', () => {
    const wt = createWorktree(repoDir, 'to-remove');
    removeWorktree(repoDir, wt.path);
    expect(listWorktrees(repoDir).length).toBe(1);
  });

  it('throws on duplicate name', () => {
    createWorktree(repoDir, 'dup');
    expect(() => createWorktree(repoDir, 'dup')).toThrow('already exists');
  });
});
