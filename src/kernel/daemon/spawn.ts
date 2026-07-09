// src/kernel/daemon/spawn.ts
//
// Detached daemon spawn, shared by `tlive start` and the hook shim's
// session-start lazy-start. Both bundles sit side by side in dist/src.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function daemonEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'tlive-daemon.mjs');
}

export function spawnDaemonDetached(home: string, entryPath?: string): number | null {
  const entry = entryPath ?? daemonEntryPath();
  if (!existsSync(entry)) return null;
  mkdirSync(home, { recursive: true });
  const logFd = openSync(join(home, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  return child.pid ?? null;
}
