// src/workspace/git-aware.ts
//
// Lightweight git metadata detection for `tlive setup` / workspace creation.
// Reads the origin URL, current branch, and dirty state so operators can see
// workspace provenance at a glance. Also infers a workspace name from
// package.json / pyproject.toml when available. All probes fail-soft:
// non-git directories, missing git binary, and permission errors return a
// bare `{ suggestedName }`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { promises as fs } from 'node:fs';

const pExec = promisify(execFile);

export interface GitContext {
  gitRemote?: string;
  headBranch?: string;
  dirty?: boolean;
  /** Inferred display name — directory basename unless package.json.name wins. */
  suggestedName: string;
}

export async function detectGitContext(cwd: string): Promise<GitContext> {
  const suggestedName = basename(cwd) || 'workspace';
  try {
    const [remote, branch, status] = await Promise.all([
      pExec('git', ['config', '--get', 'remote.origin.url'], { cwd }).catch(() => ({ stdout: '' })),
      pExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).catch(() => ({ stdout: '' })),
      pExec('git', ['status', '--porcelain'], { cwd }).catch(() => ({ stdout: '' })),
    ]);
    const gitRemote = remote.stdout.trim() || undefined;
    const headBranch = branch.stdout.trim() || undefined;
    const dirty = status.stdout.trim().length > 0;

    const inferred = await inferNameFromManifests(cwd);
    return {
      gitRemote,
      headBranch,
      dirty,
      suggestedName: inferred ?? suggestedName,
    };
  } catch {
    return { suggestedName };
  }
}

async function inferNameFromManifests(cwd: string): Promise<string | undefined> {
  // package.json.name wins
  const pkg = await fs.readFile(`${cwd}/package.json`, 'utf8').catch(() => '');
  const pkgMatch = pkg && /"name"\s*:\s*"([^"]+)"/.exec(pkg);
  if (pkgMatch?.[1]) return pkgMatch[1];

  // pyproject.toml [project].name as a fallback
  const pyproject = await fs.readFile(`${cwd}/pyproject.toml`, 'utf8').catch(() => '');
  if (pyproject) {
    const projectMatch = /\[project\][^\[]*?name\s*=\s*"([^"]+)"/s.exec(pyproject);
    if (projectMatch?.[1]) return projectMatch[1];
  }

  return undefined;
}

/** Back-compat alias used in plan step 14 snippet. */
export const detect = detectGitContext;
