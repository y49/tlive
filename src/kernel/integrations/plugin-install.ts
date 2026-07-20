// src/kernel/integrations/plugin-install.ts
//
// Orchestrate the VENDOR's own plugin manager to register tlive's bundled
// marketplaces — tlive no longer hand-edits user config files. Old vendors
// without a plugin CLI: manual setup documented in the README appendix.
//
// Update semantics differ per vendor (both source-verified):
//  - claude: `marketplace add` does NOT refresh an already-registered source
//    and `install` skips an already-installed plugin — updating requires the
//    explicit `marketplace update` + `plugin update` pair, and a stale cache
//    is silent. So we VERIFY afterwards: `plugin list --json` must show the
//    bundled version, otherwise setup fails loudly instead of shipping stale
//    hooks/skills (the "stuck at 2.0.0" class of bug).
//  - codex: `plugin add` is an upsert — it re-materializes from the live
//    local marketplace dir and atomically replaces the cache root
//    (core-plugins/src/manager.rs install_resolved_plugin), so running it is
//    the refresh. Verified the same way afterwards.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

/** The version shipped in this build's bundled plugin manifest, or null if
 *  unreadable (never throws — version verification then degrades to a
 *  best-effort "refreshed" message). */
export function bundledPluginVersion(vendor: 'claude' | 'codex'): string | null {
  const tail = vendor === 'claude'
    ? join('plugins', 'claude', 'plugins', 'tlive', '.claude-plugin', 'plugin.json')
    : join('plugins', 'codex', 'plugins', 'tlive', '.codex-plugin', 'plugin.json');
  // bundled: dist/src/../../plugins;从源码跑(测试)差一级 → 再退一级。
  for (const root of [pkgRoot(), join(pkgRoot(), '..')]) {
    try {
      const v = (JSON.parse(readFileSync(join(root, tail), 'utf-8')) as { version?: unknown }).version;
      if (typeof v === 'string') return v;
    } catch { /* try next root */ }
  }
  return null;
}

/** Tri-state probe of the installed tlive@tlive plugin: `absent` is a real
 *  "not installed" (the list parsed fine and tlive wasn't in it), `unknown`
 *  means the CLI/flag/shape is unavailable (old versions) — callers must not
 *  treat `unknown` as `absent` or every old CLI screams "NOT INSTALLED". */
export function installedPluginProbe(run: Runner, vendor: 'claude' | 'codex'):
  { state: 'ok'; version: string } | { state: 'absent' } | { state: 'unknown' } {
  const r = run(vendor, ['plugin', 'list', '--json']);
  if (!r.ok) return { state: 'unknown' };
  try {
    const parsed = JSON.parse(r.output) as unknown;
    // claude: top-level array of {id, version}; codex: {installed:[{pluginId, version}]}
    const entries = Array.isArray(parsed)
      ? parsed
      : (parsed as { installed?: unknown[] }).installed ?? [];
    for (const e of entries as Array<{ id?: string; pluginId?: string; version?: string }>) {
      if ((e.id ?? e.pluginId) === 'tlive@tlive' && typeof e.version === 'string') return { state: 'ok', version: e.version };
    }
    return { state: 'absent' };
  } catch {
    return { state: 'unknown' };
  }
}

/** Installed tlive@tlive version, or null when absent/unverifiable. */
export function installedPluginVersion(run: Runner, vendor: 'claude' | 'codex'): string | null {
  const p = installedPluginProbe(run, vendor);
  return p.state === 'ok' ? p.version : null;
}

const alreadyOk = (r: { ok: boolean; output: string }): boolean => r.ok || /already/i.test(r.output);

/** One status line describing a vendor's plugin health, or null when the
 *  vendor CLI isn't there (nothing to report). Exists because the plugin
 *  silently disappearing is a REAL failure mode we lived through (2026-07-20:
 *  gone for 3 days, zero hook traffic, zero cards, nothing noticed) — and a
 *  session started while it's missing runs without hooks until restarted. */
export function pluginHealth(vendor: 'claude' | 'codex', run: Runner, hasVendor: () => boolean = () => commandOnPath(vendor)): string | null {
  if (!hasVendor()) return null;
  const bundled = bundledPluginVersion(vendor);
  const probe = installedPluginProbe(run, vendor);
  if (probe.state === 'absent') {
    return `${vendor}: plugin NOT INSTALLED — hooks inactive, no cards. Run: tlive setup --hooks-only (then restart sessions)`;
  }
  if (probe.state === 'unknown') {
    return `${vendor}: plugin state unverifiable on this CLI`;
  }
  if (bundled && probe.version !== bundled) {
    return `${vendor}: plugin ${probe.version} (this build ships ${bundled}) — run: tlive setup --hooks-only`;
  }
  return `${vendor}: plugin ${probe.version} ✓`;
}

/** Post-install verification shared by both vendors. Only a *provable*
 *  mismatch fails — when either side of the comparison is unreadable we
 *  can't tell, and failing setup on a missing --json flag would break every
 *  older vendor CLI for zero safety. */
function verifyInstalled(run: Runner, vendor: 'claude' | 'codex', freshInstall: boolean): { ok: boolean; detail: string } {
  const verb = freshInstall ? 'installed' : 'refreshed';
  const expected = bundledPluginVersion(vendor);
  const actual = installedPluginVersion(run, vendor);
  if (expected && actual && actual !== expected) {
    return {
      ok: false,
      detail: `plugin cache is still at ${actual}, expected ${expected} — run \`${vendor} plugin update tlive@tlive\` manually, then re-run setup`,
    };
  }
  if (expected && actual) return { ok: true, detail: `tlive@tlive ${verb} at ${actual}` };
  return { ok: true, detail: `tlive@tlive ${verb}${expected ? ` (expected ${expected}, cache version unverifiable on this CLI)` : ''}` };
}

export function installClaudePlugin(run: Runner): { ok: boolean; detail: string } {
  if (!run('claude', ['plugin', 'list']).ok) {
    return { ok: false, detail: 'claude plugin CLI unavailable (old version?) — see docs for manual hooks' };
  }
  const mk = run('claude', ['plugin', 'marketplace', 'add', claudePluginDir()]);
  if (!alreadyOk(mk)) return { ok: false, detail: `marketplace add failed: ${mk.output.slice(0, 200)}` };
  // marketplace add 对已注册的 marketplace 不刷新 source —— 必须 update 才会从
  // bundled 目录重读最新 version;否则升级 tlive 后插件永远停在旧版(实测坑)。
  // update 失败不能吞:后面的 plugin update 会"成功"地更到旧 source 上。
  const mkUp = run('claude', ['plugin', 'marketplace', 'update', 'tlive']);
  if (!alreadyOk(mkUp) && !/up.to.date|latest/i.test(mkUp.output)) {
    return { ok: false, detail: `marketplace update failed: ${mkUp.output.slice(0, 200)}` };
  }
  const inst = run('claude', ['plugin', 'install', 'tlive@tlive', '--scope', 'user']);
  if (!alreadyOk(inst)) return { ok: false, detail: `plugin install failed: ${inst.output.slice(0, 200)}` };
  // install 对已装插件跳过 —— 已装则 update 到刷新后的 version。
  const fresh = !/already/i.test(inst.output);
  if (!fresh) {
    const up = run('claude', ['plugin', 'update', 'tlive@tlive']);
    if (!up.ok && !/already|up.to.date|latest/i.test(up.output)) {
      return { ok: false, detail: `plugin update failed: ${up.output.slice(0, 200)}` };
    }
  }
  return verifyInstalled(run, 'claude', fresh);
}

export function installCodexPlugin(run: Runner, hasCodex: () => boolean = () => commandOnPath('codex')): { ok: boolean; detail: string } {
  if (!hasCodex()) return { ok: false, detail: 'codex not on PATH' };
  const mk = run('codex', ['plugin', 'marketplace', 'add', codexPluginDir()]);
  if (!alreadyOk(mk)) return { ok: false, detail: `marketplace add failed: ${mk.output.slice(0, 200)}` };
  // codex 的 `plugin add` 是 upsert(源码:install_resolved_plugin 从活目录
  // 重新物化 + 原子替换 cache root)—— 重跑即刷新,没有单独的 update 命令。
  const inst = run('codex', ['plugin', 'add', 'tlive@tlive']);
  if (!alreadyOk(inst)) return { ok: false, detail: `plugin add failed: ${inst.output.slice(0, 200)}` };
  // fresh marketplace registration ⟹ first install; a pre-registered one
  // means the add above acted as a refresh.
  return verifyInstalled(run, 'codex', mk.ok && !/already/i.test(mk.output));
}
