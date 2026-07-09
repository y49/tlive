// src/kernel/integrations/hooks-cleanup.ts
//
// Post-plugin-migration cleanup: strip the hook entries tlive used to write
// DIRECTLY into vendor config (pre-plugin installs). Prevents double-fire
// once the plugin-provided hooks are active. Only removes entries tlive
// itself wrote (CC: `_tlive` marker; Codex: `tlive hook` command prefix) —
// user-owned hooks are never touched. Direct-write installers are retired;
// manual setup for old vendors lives in the docs.
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

/** 是否有可执行 <cmd> 在 PATH 上(跨平台,只读)。 */
export function commandOnPath(cmd: string): boolean {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  return dirs.some((d) => exts.some((e) => { try { return statSync(join(d, cmd + e)).isFile(); } catch { return false; } }));
}

type Group = { matcher?: string; hooks?: Array<Record<string, unknown>> };

function stripGroups(
  path: string,
  isOurs: (h: Record<string, unknown>) => boolean,
): boolean {
  if (!existsSync(path)) return false;
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>; } catch { return false; }
  const hooks = cfg.hooks as Record<string, Group[]> | undefined;
  if (!hooks || typeof hooks !== 'object') return false;
  let changed = false;
  for (const ev of Object.keys(hooks)) {
    const kept = (hooks[ev] ?? []).filter((g) => !(g.hooks ?? []).some(isOurs));
    if (kept.length !== (hooks[ev] ?? []).length) changed = true;
    if (kept.length === 0) delete hooks[ev];
    else hooks[ev] = kept;
  }
  if (changed) writeFileSync(path, JSON.stringify(cfg, null, 2));
  return changed;
}

/** 剥离 tlive 旧直写进 ~/.claude/settings.json 的 hooks(按 _tlive 标记)。 */
export function stripLegacyClaudeHooks(): boolean {
  return stripGroups(join(homedir(), '.claude', 'settings.json'), (h) => h._tlive === true);
}

/** 剥离 tlive 旧直写进 ~/.codex/hooks.json 的 hooks(按命令前缀)。 */
export function stripLegacyCodexHooks(): boolean {
  return stripGroups(join(homedir(), '.codex', 'hooks.json'),
    (h) => typeof h.command === 'string' && (h.command as string).startsWith('tlive hook'));
}

/** Codex 插件 cache 内 tlive hooks.json 的路径(codex 0.142 实测布局:<mk>/<plugin>/local/)。 */
export function codexPluginHooksPath(codexHome: string): string {
  return join(codexHome, 'plugins', 'cache', 'tlive', 'tlive', 'local', 'hooks', 'hooks.json');
}
