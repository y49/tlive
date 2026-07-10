// src/kernel/integrations/hooks-cleanup.ts
//
// Vendor-integration helpers shared by setup/status. Hook registration itself
// rides in the bundled plugins (see plugins/); tlive does NOT hand-edit vendor
// config files. Users of pre-plugin dev builds: remove old direct-written
// entries manually — see docs/manual-hooks.md appendix.
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';

/** 是否有可执行 <cmd> 在 PATH 上(跨平台,只读)。 */
export function commandOnPath(cmd: string): boolean {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  return dirs.some((d) => exts.some((e) => { try { return statSync(join(d, cmd + e)).isFile(); } catch { return false; } }));
}

/** Codex 插件 cache 内 tlive hooks.json 的实际路径,未安装则 null。
 *  实测布局(codex 0.142):<cache>/tlive/tlive/<版本目录>/hooks/hooks.json —— 版本目录
 *  是 plugin.json 的 version(如 "2.0.0"),无 version 时曾见 "local",故扫描解析而非猜。 */
export function codexPluginHooksPath(codexHome: string): string | null {
  const base = join(codexHome, 'plugins', 'cache', 'tlive', 'tlive');
  try {
    for (const entry of readdirSync(base)) {
      const p = join(base, entry, 'hooks', 'hooks.json');
      if (existsSync(p)) return p;
    }
  } catch { /* cache 不存在 = 未安装 */ }
  return null;
}
