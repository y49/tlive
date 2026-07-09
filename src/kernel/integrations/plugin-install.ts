// src/kernel/integrations/plugin-install.ts
//
// Orchestrate the VENDOR's own plugin manager to register tlive's bundled
// marketplaces — tlive no longer hand-edits user config files. Old vendors
// without a plugin CLI: manual setup documented in the README appendix.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandOnPath } from './hooks-cleanup.js';

export type Runner = (cmd: string, args: string[]) => { ok: boolean; output: string };

export function defaultRunner(): Runner {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 15_000, windowsHide: true });
    return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
}

// bundle 后本模块在 dist/src/tlive-cli.mjs;包根 = dist/src/../../
function pkgRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}
export function claudePluginDir(): string { return join(pkgRoot(), 'plugins', 'claude'); }
export function codexPluginDir(): string { return join(pkgRoot(), 'plugins', 'codex'); }

const alreadyOk = (r: { ok: boolean; output: string }): boolean => r.ok || /already/i.test(r.output);

export function installClaudePlugin(run: Runner): { ok: boolean; detail: string } {
  if (!run('claude', ['plugin', 'list']).ok) {
    return { ok: false, detail: 'claude plugin CLI unavailable (old version?) — see docs for manual hooks' };
  }
  const mk = run('claude', ['plugin', 'marketplace', 'add', claudePluginDir()]);
  if (!alreadyOk(mk)) return { ok: false, detail: `marketplace add failed: ${mk.output.slice(0, 200)}` };
  const inst = run('claude', ['plugin', 'install', 'tlive@tlive', '--scope', 'user', '-y']);
  if (!alreadyOk(inst)) return { ok: false, detail: `plugin install failed: ${inst.output.slice(0, 200)}` };
  return { ok: true, detail: 'tlive@tlive installed (user scope)' };
}

export function installCodexPlugin(run: Runner, hasCodex: () => boolean = () => commandOnPath('codex')): { ok: boolean; detail: string } {
  if (!hasCodex()) return { ok: false, detail: 'codex not on PATH' };
  const mk = run('codex', ['plugin', 'marketplace', 'add', codexPluginDir()]);
  if (!alreadyOk(mk)) return { ok: false, detail: `marketplace add failed: ${mk.output.slice(0, 200)}` };
  const inst = run('codex', ['plugin', 'add', 'tlive@tlive']);
  if (!alreadyOk(inst)) return { ok: false, detail: `plugin add failed: ${inst.output.slice(0, 200)}` };
  return { ok: true, detail: 'tlive@tlive installed' };
}
