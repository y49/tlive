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
// tlive occupies exactly ONE notification slot: every send replaces the
// previous one via --print-id/--replace-id (a multi-agent burst used to stack
// dozens of separate toasts). Sends are serialized so a burst can't race past
// the id capture and fork into parallel slots.
//
// Linux `notify-send` only for now; anywhere else (or when the binary is
// missing) this degrades to a silent no-op — the card and dashboard remain
// the canonical channels.

import { spawn } from 'node:child_process';
import { commandOnPath } from '../integrations/hooks-cleanup.js';

/** Runs the command and resolves its stdout (null on any failure). */
export type Spawner = (cmd: string, args: string[]) => Promise<string | null>;

const defaultSpawner: Spawner = (cmd, args) =>
  new Promise((resolve) => {
    try {
      const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      c.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      c.on('error', () => resolve(null));
      c.on('close', () => resolve(out));
    } catch { resolve(null); }
  });

export function createDesktopNotifier(opts?: {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  hasCmd?: (cmd: string) => boolean;
  spawner?: Spawner;
}): (title: string, body: string) => Promise<void> {
  const enabled = opts?.enabled ?? true;
  const platform = opts?.platform ?? process.platform;
  const hasCmd = opts?.hasCmd ?? commandOnPath;
  if (!enabled || platform !== 'linux' || !hasCmd('notify-send')) return async () => {};
  const sp = opts?.spawner ?? defaultSpawner;
  let lastId: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  return (title, body) => {
    chain = chain.then(async () => {
      const args = [
        '--app-name=tlive',
        // 15s expiry: long enough to notice, short enough not to linger.
        '--expire-time=15000',
        '--print-id',
        ...(lastId ? [`--replace-id=${lastId}`] : []),
        title,
        body,
      ];
      const id = (await sp('notify-send', args))?.trim();
      // Old notify-send without --print-id prints nothing → keep stacking
      // behavior rather than passing garbage to --replace-id.
      if (id && /^\d+$/.test(id)) lastId = id;
    }).catch(() => { /* best-effort, never throws */ });
    return chain;
  };
}
