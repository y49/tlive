// src/cli/subcommands/install-integrations.ts
//
// Write Claude hook entries into ~/.claude/settings.json (idempotent).
// Each entry is tagged with _tlive:true so it can be cleanly removed/replaced.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

type HookEntry = { type: 'command'; command: string; timeout?: number; _tlive: true };
type HookGroup = { matcher?: string; hooks: HookEntry[] };

const HOOK = (cmd: string, timeout?: number): HookEntry => ({
  type: 'command',
  command: `tlive hook ${cmd}`,
  ...(timeout !== undefined ? { timeout } : {}),
  _tlive: true,
});

export async function runInstallIntegrations(_argv: string[]): Promise<void> {
  const dir = join(homedir(), '.claude');
  const p = join(dir, 'settings.json');
  mkdirSync(dir, { recursive: true });

  const cfg: Record<string, unknown> = existsSync(p)
    ? (JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>)
    : {};

  if (!cfg.hooks || typeof cfg.hooks !== 'object') cfg.hooks = {};
  const hooks = cfg.hooks as Record<string, HookGroup[]>;

  // Idempotent: remove existing tlive entries before re-adding.
  const put = (event: string, group: HookGroup): void => {
    hooks[event] = (hooks[event] ?? []).filter(
      (g) => !(g.hooks ?? []).some((h: HookEntry) => h._tlive),
    );
    hooks[event].push(group);
  };

  put('PreToolUse', { matcher: '*', hooks: [HOOK('pre-tool-use', 300)] });
  put('Stop', { hooks: [HOOK('stop', 180)] });
  put('PostToolUse', { matcher: '*', hooks: [HOOK('post-tool-use')] });
  put('Notification', { hooks: [HOOK('notification')] });

  writeFileSync(p, JSON.stringify(cfg, null, 2));
  process.stdout.write(`✓ tlive hooks written to ${p}\n`);
  process.stdout.write('Restart claude for hook changes to take effect.\n');
}
