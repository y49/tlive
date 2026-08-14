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
// Model: one notification per waiting thing. Each call to `notify` posts a
// fresh, independent toast — no id is kept, nothing is replaced, nothing is
// ever retracted. The notification behaves like every other application's:
// it banners, then ages into the notification centre, where the user clears
// it or ignores it. A caller with several things waiting at once fires
// several notifications; there is no aggregate view and no lifecycle to keep
// in sync with the set of waiting things.
//
// Platform coverage (the notification's whole job is calling the user BACK
// to the terminal — never a decision surface, on any platform):
// - linux: notify-send — one call per notification, no flags beyond the app
//   name.
// - win32: PowerShell WinRT toast — one Show() per notification.
// - darwin: osascript `display notification` — one call per notification.
// Missing binary anywhere → silent no-op — the card and dashboard remain the
// canonical channels. win32/darwin paths are spec-derived, not yet verified
// on real hardware.

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

export interface DesktopNotifier {
  /** Fire one notification about one waiting thing. Fire-and-forget: no id is
   *  kept, nothing is replaced, nothing is ever retracted. The notification
   *  behaves like every other application's — it banners, then ages into the
   *  notification centre, where the user clears it or ignores it. */
  notify(title: string, body: string): Promise<void>;
}

const NOOP: DesktopNotifier = {
  notify: async () => {},
};

export function createDesktopNotifier(opts?: {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  hasCmd?: (cmd: string) => boolean;
  spawner?: Spawner;
  /** Optional — this factory must NOT import a logger itself (it is dumb IO
   *  whose tests inject every side effect). Fired exactly ONCE per call, on
   *  every return path including the no-op ones: a channel that silently
   *  resolved to a no-op is precisely the case worth knowing about
   *  (bootstrap.ts passes its `logJson`). */
  log?: (msg: string, fields: Record<string, unknown>) => void;
}): DesktopNotifier {
  const enabled = opts?.enabled ?? true;
  const platform = opts?.platform ?? process.platform;
  const hasCmd = opts?.hasCmd ?? commandOnPath;
  const log = opts?.log;
  // The whole answer to "why do I never get toasts", from the log alone, with
  // no probe fired at the user's screen. `reason` is only meaningful (and only
  // included) when the channel is NOT active — an active channel needs no
  // justification.
  const channel = (active: boolean, reason?: string): void => {
    log?.('desktop.channel', { active, platform, ...(reason ? { reason } : {}) });
  };
  if (!enabled) { channel(false, 'disabled'); return NOOP; }
  // Backstop, not politeness: most bootstrap tests never inject the notifier
  // seam, so without this a full `pnpm test` fires real toasts carrying fixture
  // session names onto the developer's desktop. Injecting a spawner is the
  // explicit "I am testing the real implementation" signal, and must still
  // reach the code below — an unconditional no-op would disable this file's
  // own tests silently. Precedent: bootstrap's forceExit VITEST guard.
  //
  // Checked BEFORE any platform branching, deliberately — this is what makes
  // `hasCmd` PROVABLY never consulted under vitest without an injected
  // spawner (see this file's own "vitest backstop" test), a structural
  // property a self-reported log line cannot substitute for.
  if (process.env.VITEST && !opts?.spawner) { channel(false, 'vitest'); return NOOP; }
  if (platform === 'darwin') {
    // Not 'no-notify-send' — that binary is linux-only; naming it here would
    // send a macOS user hunting for something that never existed on their
    // platform.
    if (!hasCmd('osascript')) { channel(false, 'no-backend'); return NOOP; }
    channel(true);
    return darwinNotifier(opts?.spawner ?? defaultSpawner);
  }
  if (platform === 'win32') {
    if (!hasCmd('powershell')) { channel(false, 'no-backend'); return NOOP; }
    channel(true);
    return win32Notifier(opts?.spawner ?? defaultSpawner);
  }
  if (platform !== 'linux') { channel(false, 'unsupported-platform'); return NOOP; }
  if (!hasCmd('notify-send')) { channel(false, 'no-notify-send'); return NOOP; }
  channel(true);
  const sp = opts?.spawner ?? defaultSpawner;
  return {
    notify: async (title, body) => {
      // No --expire-time: the server's own policy applies, so the banner shows
      // briefly and the entry persists in the panel. No `transient` hint
      // either — that hint means "do not persist", the opposite of what is
      // wanted here. No --print-id: nothing will ever come back for this.
      await sp('notify-send', ['--app-name=tlive', title, body]);
    },
  };
}

/** macOS: built-in osascript. Every call posts a fresh banner; there is
 *  nothing to replace or close. */
function darwinNotifier(sp: Spawner): DesktopNotifier {
  const esc = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return {
    notify: async (title, body) => {
      await sp('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`]);
    },
  };
}

/** Windows 10/11: WinRT toast via PowerShell (no modules needed). The
 *  well-known PowerShell AppId is used because unregistered AppIds may not
 *  render toasts. Spec-derived — pending real-hardware verification. */
const WIN_APP_ID = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`;

/** One toast per waiting thing. No Tag, Group, History.Remove or
 *  SuppressPopup: those existed to keep a single slot current, and there is no
 *  slot any more. */
export function win32NotifyScript(title: string, body: string): string {
  const esc = (v: string): string =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  return [
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null`,
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual></toast>')`,
    `$t = [Windows.UI.Notifications.ToastNotification]::new($xml)`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WIN_APP_ID}').Show($t)`,
  ].join('; ');
}

function win32Notifier(sp: Spawner): DesktopNotifier {
  const run = (script: string): Promise<string | null> =>
    sp('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script]);
  return {
    notify: async (title, body) => { await run(win32NotifyScript(title, body)); },
  };
}
