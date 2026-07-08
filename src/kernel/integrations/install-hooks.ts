// src/kernel/integrations/install-hooks.ts
//
// Write tlive's Claude hook entries into ~/.claude/settings.json (idempotent).
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

type HookEntry = { type: 'command'; command: string; timeout?: number; _tlive: true };
type HookGroup = { matcher?: string; hooks: HookEntry[] };

const HOOK = (cmd: string, timeout?: number): HookEntry => ({
  type: 'command',
  command: `tlive hook ${cmd}`,
  ...(timeout !== undefined ? { timeout } : {}),
  _tlive: true,
});

export function installClaudeHooks(): string {
  const dir = join(homedir(), '.claude');
  const p = join(dir, 'settings.json');
  mkdirSync(dir, { recursive: true });
  const cfg: Record<string, unknown> = existsSync(p)
    ? (JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>)
    : {};
  if (!cfg.hooks || typeof cfg.hooks !== 'object') cfg.hooks = {};
  const hooks = cfg.hooks as Record<string, HookGroup[]>;
  const put = (event: string, group: HookGroup): void => {
    hooks[event] = (hooks[event] ?? []).filter((g) => !(g.hooks ?? []).some((h: HookEntry) => h._tlive));
    hooks[event].push(group);
  };
  put('PreToolUse', { matcher: '*', hooks: [HOOK('pre-tool-use', 600)] });
  put('Stop', { hooks: [HOOK('stop', 180)] });
  put('PostToolUse', { matcher: '*', hooks: [HOOK('post-tool-use')] });
  put('Notification', { hooks: [HOOK('notification')] });
  put('UserPromptSubmit', { hooks: [HOOK('user-prompt-submit')] });
  put('SessionStart', { hooks: [HOOK('session-start')] });
  put('SessionEnd', { hooks: [HOOK('session-end')] });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

/** 是否有可执行 <cmd> 在 PATH 上(跨平台,只读无副作用)。 */
export function commandOnPath(cmd: string): boolean {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  return dirs.some((d) =>
    exts.some((e) => { try { return statSync(join(d, cmd + e)).isFile(); } catch { return false; } }),
  );
}

type CodexHook = { type: 'command'; command: string; timeout?: number; async: false };
type CodexGroup = { matcher?: string; hooks: CodexHook[] };

/** 写 tlive 的 Codex hook 到 ~/.codex/hooks.json(幂等,按命令串匹配,不注入外来字段)。 */
export function installCodexHooks(): string {
  const dir = join(homedir(), '.codex');
  const p = join(dir, 'hooks.json');
  mkdirSync(dir, { recursive: true });
  const cfg: Record<string, unknown> = existsSync(p)
    ? (JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>)
    : {};
  if (!cfg.hooks || typeof cfg.hooks !== 'object') cfg.hooks = {};
  const hooks = cfg.hooks as Record<string, CodexGroup[]>;
  const cmd = (event: string, timeout?: number): CodexHook => ({
    type: 'command',
    command: `tlive hook --codex ${event}`,
    ...(timeout !== undefined ? { timeout } : {}),
    async: false,
  });
  const put = (event: string, group: CodexGroup): void => {
    // 幂等:去掉任何 tlive 装过的组(按命令串前缀,不靠标记字段——Codex config
    // schema 目前容忍未知键但外来字段是味道,且未来可能收紧)。
    hooks[event] = (hooks[event] ?? []).filter(
      (g) => !(g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.startsWith('tlive hook')),
    );
    hooks[event].push(group);
  };
  put('PreToolUse', { matcher: '*', hooks: [cmd('pre-tool-use', 600)] });
  put('Stop', { hooks: [cmd('stop', 170)] });
  put('PostToolUse', { matcher: '*', hooks: [cmd('post-tool-use')] });
  put('UserPromptSubmit', { hooks: [cmd('user-prompt-submit')] });
  put('SessionStart', { matcher: 'startup|resume|clear|compact', hooks: [cmd('session-start')] });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}
