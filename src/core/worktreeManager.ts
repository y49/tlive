// src/core/worktreeManager.ts
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

export interface WorktreeInfo {
  path: string;
  branch: string;
  name: string;
}

export function createWorktree(repoDir: string, name?: string): WorktreeInfo {
  const repoName = basename(repoDir);
  const sessionPrefix = name ?? `tlive-${Date.now().toString(36).slice(-4)}`;
  const worktreeDir = join(dirname(repoDir), `${repoName}-worktrees`, sessionPrefix);
  const branch = `tlive/${sessionPrefix}`;

  if (existsSync(worktreeDir)) {
    throw new Error(`Worktree already exists: ${worktreeDir}`);
  }

  execSync(`git worktree add "${worktreeDir}" -b "${branch}"`, {
    cwd: repoDir,
    stdio: 'pipe',
  });

  return { path: worktreeDir, branch, name: sessionPrefix };
}

export function removeWorktree(repoDir: string, worktreePath: string): void {
  execSync(`git worktree remove "${worktreePath}" --force`, {
    cwd: repoDir,
    stdio: 'pipe',
  });
}

export function listWorktrees(repoDir: string): string[] {
  const output = execSync('git worktree list --porcelain', {
    cwd: repoDir,
    encoding: 'utf-8',
  });
  return output.split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length));
}
