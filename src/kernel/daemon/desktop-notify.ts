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
// - ONE notification slot total: every ping/render replaces the previous
//   toast via --print-id/--replace-id (a burst used to stack dozens of toasts).
// - RESIDENT, not transient: the slot's toast never expires on its own
//   (--expire-time=0) — step away for five minutes and the signal must still
//   be there when you get back. It used to self-expire with a `transient`
//   hint so an expired toast would evaporate instead of falling into the
//   desktop's notification tray as an "answered long ago, still shows Waiting
//   for approval" zombie; clear() (below) replaces that treatment for the
//   normal path. Trade-off: unlike the old 15s expiry, this is not
//   self-healing if the daemon dies with a toast up — it stays resident
//   until dismissed by hand. A later task closes that gap with clear()
//   calls on daemon shutdown and startup.
// - clear(): when the last pending approval resolves, the live toast is
//   actively closed over DBus (CloseNotification) — answered means gone.
// - info(): a SEPARATE one-shot banner for the idle "waiting for your input"
//   nudge — low-frequency and actionable (a per-turn "finished" toast would
//   flood, so completion stays on IM, not here). It lives outside the waiting
//   slot entirely — never replaces or clears the waiting toast, and (unlike
//   the slot) still self-expires via the `transient` hint, since nothing
//   ever calls clear() on it.
// - CLICK TO ANSWER: an optional `action` renders a button on the toast
//   (freedesktop actions via `notify-send --action`); clicking it runs the
//   callback — bootstrap wires it to open the tlive dashboard, so the toast
//   is an entrance, not just a pointer. Timing pinned live on this machine:
//   with --action, --print-id emits the id IMMEDIATELY (~4ms), then the
//   process waits and prints the action name on click / exits on expiry.
// - Sends are serialized so a burst can't race past the id capture and fork
//   into parallel slots. A replaced ping/render's waiter is killed and its
//   callbacks ignored, so a click can never fire twice through a superseded
//   process.
//
// Platform coverage (the notification's core value is calling the user BACK
// to the terminal — click-to-answer is a Linux bonus, not the bar):
// - linux: notify-send — full model (single resident slot, close, action).
// - win32: PowerShell WinRT toast — single slot via Tag replace + active
//   clear via ToastNotificationManager History. No click action (v1).
// - darwin: osascript `display notification` — ping only; banners
//   auto-dismiss, Notification Center accumulation is macOS-managed.
// Missing binary anywhere → silent no-op — the card and dashboard remain
// the canonical channels. win32/darwin paths are spec-derived, not yet
// verified on real hardware.

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

/** Where the live toast's id survives a daemon restart. Absent → no
 *  persistence (tests, and platforms with no resident slot). */
export interface ToastIdStore {
  read(): string | null;
  write(id: string | null): void;
}

export interface DesktopNotifier {
  /** Show (or replace) THE interactive waiting toast (a pending approval).
   *  Single-slot + cleared by clear() — "exists exactly while you're needed". */
  ping(title: string, body: string): Promise<void>;
  /** Show (or replace) THE waiting toast. Resident: it stays until clear().
   *  Single slot — a machine shows one toast listing everything that waits. */
  render(title: string, body: string): Promise<void>;
  /** Close the waiting toast — nothing is waiting anymore. */
  clear(): Promise<void>;
  /** Fire a one-shot banner for a low-frequency, genuinely-actionable poke —
   *  the idle "waiting for your input" nudge (NOT per-turn completion, which
   *  would flood). Independent of the waiting slot: a fresh toast every time,
   *  never replaces or clears ping()'s slot, and self-expires (transient). */
  info(title: string, body: string): Promise<void>;
}

const NOOP: DesktopNotifier = {
  ping: async () => {},
  render: async () => {},
  clear: async () => {},
  info: async () => {},
};

export function createDesktopNotifier(opts?: {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  hasCmd?: (cmd: string) => boolean;
  spawner?: Spawner;
  streamSpawner?: StreamSpawner;
  /** Toast button; clicking runs `run` (bootstrap: open the dashboard). */
  action?: { label: string; run: () => void };
  /** Persists the linux slot's notify-send id across a restart. Absent →
   *  in-memory only, same as before this seam existed. */
  idStore?: ToastIdStore;
}): DesktopNotifier {
  const enabled = opts?.enabled ?? true;
  const platform = opts?.platform ?? process.platform;
  const hasCmd = opts?.hasCmd ?? commandOnPath;
  if (!enabled) return NOOP;
  // Backstop, not politeness: most bootstrap tests never inject the notifier
  // seam, so without this a full `pnpm test` fires real toasts carrying fixture
  // session names onto the developer's desktop. Injecting a spawner is the
  // explicit "I am testing the real implementation" signal, and must still
  // reach the code below — an unconditional no-op would disable this file's
  // own tests silently. Precedent: bootstrap's forceExit VITEST guard.
  if (process.env.VITEST && !opts?.spawner) return NOOP;
  if (platform === 'darwin') return hasCmd('osascript') ? darwinNotifier(opts?.spawner ?? defaultSpawner) : NOOP;
  if (platform === 'win32') return hasCmd('powershell') ? win32Notifier(opts?.spawner ?? defaultSpawner) : NOOP;
  if (platform !== 'linux' || !hasCmd('notify-send')) return NOOP;
  const sp = opts?.spawner ?? defaultSpawner;
  const ss = opts?.streamSpawner ?? defaultStreamSpawner;
  const action = opts?.action;
  const idStore = opts?.idStore;
  // Seed from the previous process's id (if any) — this single line is what
  // makes the startup clear() below real: a fresh process otherwise has no
  // way to know a predecessor left a toast up, and would silently no-op.
  let lastId: string | null = idStore?.read() ?? null;
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
  const slotArgs = (title: string, body: string): string[] => [
    '--app-name=tlive',
    // Resident, and NOT transient. The 15s+transient pair used to treat tray
    // zombies whose real cause was having no reliable way to close a toast;
    // WaitingBoard supplies that (board empties → clear()), so the treatment
    // can go. Expiring was actively wrong for the case this channel exists to
    // serve: step away for five minutes and the signal must still be there.
    '--expire-time=0',
    '--print-id',
    ...(lastId ? [`--replace-id=${lastId}`] : []),
    ...(action ? [`--action=answer=${action.label}`] : []),
    title,
    body,
  ];
  const showSlot = (title: string, body: string): Promise<void> => enqueue(async () => {
    dropLiveProc();
    const gen = generation;
    const proc = ss('notify-send', slotArgs(title, body));
    liveProc = proc;
    if (action) proc.onLine((line) => { if (generation === gen && line.trim() === 'answer') action.run(); });
    const id = (await proc.firstLine)?.trim();
    // Old notify-send without --print-id prints nothing → keep stacking
    // behavior rather than passing garbage to --replace-id.
    if (id && /^\d+$/.test(id)) { lastId = id; idStore?.write(id); }
  });
  return {
    ping: showSlot,
    render: showSlot,
    clear: () => enqueue(async () => {
      dropLiveProc();
      if (!lastId) return;
      const id = lastId;
      lastId = null;
      idStore?.write(null);
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
    // A fresh FYI toast: NOT enqueued and NOT tracked — it never touches
    // lastId/liveProc, so it can't race the waiting slot's id capture and the
    // waiting slot's clear() can't close it. No --replace-id (each is its own
    // toast); transient + 15s expiry means it self-reaps. The action (open
    // dashboard) is wired like ping's, but with no supersede/generation dance
    // — each info toast is independent and short-lived.
    info: async (title, body) => {
      const proc = ss('notify-send', [
        '--app-name=tlive',
        '--expire-time=15000',
        '--hint=int:transient:1',
        '--print-id',
        ...(action ? [`--action=answer=${action.label}`] : []),
        title,
        body,
      ]);
      if (action) proc.onLine((line) => { if (line.trim() === 'answer') action.run(); });
    },
  };
}

/** macOS: built-in osascript. Ping-only — banners auto-dismiss; there is no
 *  scriptable replace/close for Notification Center entries. */
function darwinNotifier(sp: Spawner): DesktopNotifier {
  const esc = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const show = (title: string, body: string): Promise<string | null> =>
    sp('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`]);
  return {
    ping: async (title, body) => { await show(title, body); },
    render: async (title, body) => { await show(title, body); },
    clear: async () => { /* not scriptable on macOS */ },
    // No slot on macOS anyway — an FYI banner is just another display notification.
    info: async (title, body) => { await show(title, body); },
  };
}

/** Windows 10/11: WinRT toast via PowerShell (no modules needed). Tag+Group
 *  give the single-slot replace; History.Remove gives the active clear. The
 *  well-known PowerShell AppId is used because unregistered AppIds may not
 *  render toasts. Spec-derived — pending real-hardware verification. */
const WIN_APP_ID = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`;

export function win32ToastScript(title: string, body: string, tag = 'tlive'): string {
  const esc = (v: string): string =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  return [
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null`,
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual></toast>')`,
    `$t = [Windows.UI.Notifications.ToastNotification]::new($xml)`,
    `$t.Tag = '${tag}'`,
    `$t.Group = '${tag}'`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WIN_APP_ID}').Show($t)`,
  ].join('; ');
}

export function win32ClearScript(): string {
  return [
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null`,
    `[Windows.UI.Notifications.ToastNotificationManager]::History.Remove('tlive', 'tlive', '${WIN_APP_ID}')`,
  ].join('; ');
}

function win32Notifier(sp: Spawner): DesktopNotifier {
  const run = (script: string): Promise<string | null> =>
    sp('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script]);
  return {
    ping: async (title, body) => { await run(win32ToastScript(title, body)); },
    render: async (title, body) => { await run(win32ToastScript(title, body)); },
    clear: async () => { await run(win32ClearScript()); },
    // A distinct Tag/Group so clear() (which removes the 'tlive' waiting slot)
    // never nukes an FYI banner; info toasts replace each other, not the slot.
    info: async (title, body) => { await run(win32ToastScript(title, body, 'tlive-info')); },
  };
}
