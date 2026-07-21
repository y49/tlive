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
// Lifecycle model (Warp-style): the notification exists exactly while
// something is waiting for the user, and disappears when nothing is.
// - ONE notification slot total: every ping replaces the previous toast via
//   --print-id/--replace-id (a burst used to stack dozens of toasts).
// - `transient` hint: an expired toast EVAPORATES instead of falling into the
//   desktop's notification tray/history — the tray is where "answered long
//   ago, still shows Waiting for approval" zombies came from (replace-id
//   cannot touch a toast that already expired into the tray).
// - clear(): when the last pending approval resolves, the live toast is
//   actively closed over DBus (CloseNotification) — answered means gone.
// - CLICK TO ANSWER: an optional `action` renders a button on the toast
//   (freedesktop actions via `notify-send --action`); clicking it runs the
//   callback — bootstrap wires it to open the tlive dashboard, so the toast
//   is an entrance, not just a pointer. Timing pinned live on this machine:
//   with --action, --print-id emits the id IMMEDIATELY (~4ms), then the
//   process waits and prints the action name on click / exits on expiry.
// - Sends are serialized so a burst can't race past the id capture and fork
//   into parallel slots. A replaced ping's waiter is killed and its callbacks
//   ignored, so a click can never fire twice through a superseded process.
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

/** A long-lived notify-send holding an actionable toast: first stdout line is
 *  the notification id (immediate), later lines are invoked action names. */
export interface PingProc {
  firstLine: Promise<string | null>;
  onLine(cb: (line: string) => void): void;
  kill(): void;
}
export type StreamSpawner = (cmd: string, args: string[]) => PingProc;

const defaultStreamSpawner: StreamSpawner = (cmd, args) => {
  const lineCbs: Array<(l: string) => void> = [];
  let resolveFirst: (v: string | null) => void;
  const firstLine = new Promise<string | null>((r) => { resolveFirst = r; });
  let first = true;
  try {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    c.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (first) { first = false; resolveFirst(line); }
        else for (const cb of lineCbs) cb(line);
      }
    });
    c.on('error', () => { if (first) { first = false; resolveFirst(null); } });
    c.on('close', () => { if (first) { first = false; resolveFirst(null); } });
    c.unref();
    return { firstLine, onLine: (cb) => lineCbs.push(cb), kill: () => { try { c.kill(); } catch { /* already gone */ } } };
  } catch {
    resolveFirst!(null);
    return { firstLine, onLine: () => undefined, kill: () => undefined };
  }
};

export interface DesktopNotifier {
  /** Show (or replace) THE tlive notification. */
  ping(title: string, body: string): Promise<void>;
  /** Close the live notification — nothing is waiting anymore. */
  clear(): Promise<void>;
}

const NOOP: DesktopNotifier = { ping: async () => {}, clear: async () => {} };

export function createDesktopNotifier(opts?: {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  hasCmd?: (cmd: string) => boolean;
  spawner?: Spawner;
  streamSpawner?: StreamSpawner;
  /** Toast button; clicking runs `run` (bootstrap: open the dashboard). */
  action?: { label: string; run: () => void };
}): DesktopNotifier {
  const enabled = opts?.enabled ?? true;
  const platform = opts?.platform ?? process.platform;
  const hasCmd = opts?.hasCmd ?? commandOnPath;
  if (!enabled || platform !== 'linux' || !hasCmd('notify-send')) return NOOP;
  const sp = opts?.spawner ?? defaultSpawner;
  const ss = opts?.streamSpawner ?? defaultStreamSpawner;
  const action = opts?.action;
  let lastId: string | null = null;
  let liveProc: PingProc | null = null;
  let generation = 0;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    chain = chain.then(task).catch(() => { /* best-effort, never throws */ });
    return chain;
  };
  const dropLiveProc = (): void => {
    generation++; // callbacks from the superseded waiter are ignored from here
    liveProc?.kill();
    liveProc = null;
  };
  return {
    ping: (title, body) => enqueue(async () => {
      dropLiveProc();
      const gen = generation;
      const args = [
        '--app-name=tlive',
        // 15s expiry: long enough to notice; transient → expiry means GONE,
        // not "archived into the tray as a stale Waiting-for-approval".
        '--expire-time=15000',
        '--hint=int:transient:1',
        '--print-id',
        ...(lastId ? [`--replace-id=${lastId}`] : []),
        ...(action ? [`--action=answer=${action.label}`] : []),
        title,
        body,
      ];
      const proc = ss('notify-send', args);
      liveProc = proc;
      if (action) proc.onLine((line) => { if (generation === gen && line.trim() === 'answer') action.run(); });
      const id = (await proc.firstLine)?.trim();
      // Old notify-send without --print-id prints nothing → keep stacking
      // behavior rather than passing garbage to --replace-id.
      if (id && /^\d+$/.test(id)) lastId = id;
    }),
    clear: () => enqueue(async () => {
      dropLiveProc();
      if (!lastId) return;
      const id = lastId;
      lastId = null;
      // notify-send cannot close; go straight to the DBus spec method. If
      // gdbus is absent the toast still self-expires (transient) — degraded,
      // not broken.
      await sp('gdbus', [
        'call', '--session',
        '--dest', 'org.freedesktop.Notifications',
        '--object-path', '/org/freedesktop/Notifications',
        '--method', 'org.freedesktop.Notifications.CloseNotification',
        id,
      ]);
    }),
  };
}
