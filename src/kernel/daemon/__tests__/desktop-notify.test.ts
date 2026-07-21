import { describe, it, expect, vi } from 'vitest';
import { createDesktopNotifier, type PingProc, type StreamSpawner } from '../desktop-notify';

/** Fake notify-send process: id emitted immediately (as pinned live: ~4ms even
 *  with --action), later lines are clicked action names. */
function fakeProcs() {
  const procs: Array<{ cmd: string; args: string[]; emit: (l: string) => void; killed: boolean }> = [];
  const ss: StreamSpawner = (cmd, args) => {
    const lineCbs: Array<(l: string) => void> = [];
    const rec = {
      cmd, args, killed: false,
      emit: (l: string) => { for (const cb of lineCbs) cb(l); },
    };
    procs.push(rec);
    const proc: PingProc = {
      firstLine: Promise.resolve(String(41 + procs.length)), // 42, 43, …
      onLine: (cb) => lineCbs.push(cb),
      kill: () => { rec.killed = true; },
    };
    return proc;
  };
  return { procs, ss };
}

describe('createDesktopNotifier', () => {
  const linux = { platform: 'linux' as const, hasCmd: () => true };

  it('pings notify-send with app name, expiry, and the transient hint (expired toasts must evaporate, not archive into the tray)', async () => {
    const { procs, ss } = fakeProcs();
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss });
    await n.ping('tlive · Bash', 'Waiting for approval');
    expect(procs).toHaveLength(1);
    expect(procs[0].cmd).toBe('notify-send');
    expect(procs[0].args).toContain('--app-name=tlive');
    expect(procs[0].args).toContain('--hint=int:transient:1');
    expect(procs[0].args).toContain('tlive · Bash');
    expect(procs[0].args).toContain('Waiting for approval');
    expect(procs[0].args.some((a) => a.startsWith('--action='))).toBe(false); // no action configured
  });

  it('occupies a single notification slot: second ping replaces the first (--replace-id) and kills the superseded waiter', async () => {
    const { procs, ss } = fakeProcs();
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss });
    await n.ping('a', 'b');
    await n.ping('c', 'd');
    expect(procs[0].args).toContain('--print-id');
    expect(procs[0].args.some((a) => a.startsWith('--replace-id='))).toBe(false);
    expect(procs[1].args).toContain('--replace-id=42');
    expect(procs[0].killed).toBe(true);
  });

  it('click-to-answer: the action button runs the callback; a superseded process click is ignored', async () => {
    const { procs, ss } = fakeProcs();
    const run = vi.fn();
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, action: { label: 'Open dashboard', run } });
    await n.ping('a', 'b');
    expect(procs[0].args).toContain('--action=answer=Open dashboard');
    await n.ping('c', 'd'); // supersedes the first
    procs[0].emit('answer'); // stale click from the replaced waiter
    expect(run).not.toHaveBeenCalled();
    procs[1].emit('answer'); // live click
    expect(run).toHaveBeenCalledOnce();
  });

  it('clear() closes the live notification over DBus, kills the waiter, and forgets the id', async () => {
    const { procs, ss } = fakeProcs();
    const gdbus = vi.fn(async () => '');
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, spawner: gdbus });
    await n.ping('a', 'b');
    await n.clear();
    expect(gdbus).toHaveBeenCalledOnce();
    const [cmd, args] = gdbus.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('gdbus');
    expect(args).toContain('org.freedesktop.Notifications.CloseNotification');
    expect(args).toContain('42');
    expect(procs[0].killed).toBe(true);
    // Next ping starts a fresh slot — no --replace-id pointing at a closed toast.
    await n.ping('c', 'd');
    expect(procs[1].args.some((a) => a.startsWith('--replace-id='))).toBe(false);
  });

  it('clear() with nothing live is a no-op', async () => {
    const { procs, ss } = fakeProcs();
    const gdbus = vi.fn(async () => '');
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, spawner: gdbus });
    await n.clear();
    expect(procs).toHaveLength(0);
    expect(gdbus).not.toHaveBeenCalled();
  });

  it('keeps working (without replace) when notify-send prints no id', async () => {
    const ss: StreamSpawner = (cmd, args) => ({
      firstLine: Promise.resolve(null),
      onLine: () => undefined,
      kill: () => undefined,
    });
    const argsSeen: string[][] = [];
    const wrapped: StreamSpawner = (cmd, args) => { argsSeen.push(args); return ss(cmd, args); };
    const n = createDesktopNotifier({ ...linux, streamSpawner: wrapped });
    await n.ping('a', 'b');
    await n.ping('c', 'd');
    expect(argsSeen[1].some((a) => a.startsWith('--replace-id='))).toBe(false);
  });

  it('is a silent no-op when disabled / off linux / without notify-send', async () => {
    const { procs, ss } = fakeProcs();
    await createDesktopNotifier({ ...linux, enabled: false, streamSpawner: ss }).ping('t', 'b');
    await createDesktopNotifier({ platform: 'darwin', hasCmd: () => true, streamSpawner: ss }).ping('t', 'b');
    await createDesktopNotifier({ platform: 'linux', hasCmd: () => false, streamSpawner: ss }).ping('t', 'b');
    expect(procs).toHaveLength(0);
  });
});
