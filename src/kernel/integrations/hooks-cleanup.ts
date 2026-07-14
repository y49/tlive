// src/kernel/integrations/hooks-cleanup.ts
//
// Vendor-integration helpers shared by setup/status. Hook registration itself
// rides in the bundled plugins (see plugins/); tlive does NOT hand-edit vendor
// config files. Users of pre-plugin dev builds: remove old direct-written
// entries manually — see docs/manual-hooks.md appendix.
import { statSync } from 'node:fs';
import { join, delimiter } from 'node:path';

/** 是否有可执行 <cmd> 在 PATH 上(跨平台,只读)。 */
export function commandOnPath(cmd: string): boolean {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  return dirs.some((d) => exts.some((e) => { try { return statSync(join(d, cmd + e)).isFile(); } catch { return false; } }));
}
