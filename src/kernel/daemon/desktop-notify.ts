// src/kernel/daemon/desktop-notify.ts
//
// Fire-and-forget desktop notification on the daemon's own machine, for the
// one hole the parallel-channels story leaves open (measured live, CC
// 2.1.212/2.1.215): while a PermissionRequest hook is pending, CC renders NO
// local dialog for background-launched tool calls — a user sitting at the
// computer has no answer surface there. The IM card is on their phone; the
// dashboard has buttons; this notification is the at-the-computer pointer to
// them. It never carries a decision itself — never-auto-allow untouched.
//
// Linux `notify-send` only for now; anywhere else (or when the binary is
// missing) this degrades to a silent no-op — the card and dashboard remain
// the canonical channels.

import { spawn } from 'node:child_process';
import { commandOnPath } from '../integrations/hooks-cleanup.js';

export type Spawner = (cmd: string, args: string[]) => void;

const defaultSpawner: Spawner = (cmd, args) => {
  try {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    c.on('error', () => { /* notification is best-effort, never throws */ });
    c.unref();
  } catch { /* ditto */ }
};

export function createDesktopNotifier(opts?: {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  hasCmd?: (cmd: string) => boolean;
  spawner?: Spawner;
}): (title: string, body: string) => void {
  const enabled = opts?.enabled ?? true;
  const platform = opts?.platform ?? process.platform;
  const hasCmd = opts?.hasCmd ?? commandOnPath;
  if (!enabled || platform !== 'linux' || !hasCmd('notify-send')) return () => {};
  const sp = opts?.spawner ?? defaultSpawner;
  return (title, body) => {
    // 15s expiry: long enough to notice, short enough not to pile up.
    sp('notify-send', ['--app-name=tlive', '--expire-time=15000', title, body]);
  };
}
