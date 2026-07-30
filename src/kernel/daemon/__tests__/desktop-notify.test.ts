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
  const noopSpawner = async () => '';

  it('pings notify-send with app name, resident expiry, and no transient hint (the toast must survive a coffee break, not evaporate)', async () => {
    const { procs, ss } = fakeProcs();
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, spawner: noopSpawner });
    await n.ping('tlive · Bash', 'Waiting for approval');
    expect(procs).toHaveLength(1);
    expect(procs[0].cmd).toBe('notify-send');
    expect(procs[0].args).toContain('--app-name=tlive');
    expect(procs[0].args).toContain('--expire-time=0');
    expect(procs[0].args.some((a) => a.includes('transient'))).toBe(false);
    expect(procs[0].args).toContain('tlive · Bash');
    expect(procs[0].args).toContain('Waiting for approval');
    expect(procs[0].args.some((a) => a.startsWith('--action='))).toBe(false); // no action configured
  });

  it('occupies a single notification slot: second ping replaces the first (--replace-id) and kills the superseded waiter', async () => {
    const { procs, ss } = fakeProcs();
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, spawner: noopSpawner });
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
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, spawner: noopSpawner, action: { label: 'Open dashboard', run } });
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
    const n = createDesktopNotifier({ ...linux, streamSpawner: wrapped, spawner: noopSpawner });
    await n.ping('a', 'b');
    await n.ping('c', 'd');
    expect(argsSeen[1].some((a) => a.startsWith('--replace-id='))).toBe(false);
  });

  it('info() fires a fresh one-shot banner (transient, --print-id, but NEVER --replace-id — it is not the waiting slot)', async () => {
    const { procs, ss } = fakeProcs();
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, spawner: noopSpawner });
    await n.info('myproj · Turn finished', 'Built the feature');
    expect(procs).toHaveLength(1);
    expect(procs[0].cmd).toBe('notify-send');
    expect(procs[0].args).toContain('--hint=int:transient:1');
    expect(procs[0].args).toContain('--print-id');
    expect(procs[0].args).toContain('myproj · Turn finished');
    expect(procs[0].args).toContain('Built the feature');
    expect(procs[0].args.some((a) => a.startsWith('--replace-id='))).toBe(false);
  });

  it('info() lives outside the waiting slot: it neither replaces the pending toast nor gets closed by clear()', async () => {
    const { procs, ss } = fakeProcs();
    const gdbus = vi.fn(async () => '');
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, spawner: gdbus });
    await n.ping('a', 'b');            // waiting slot → id 42
    await n.info('c', 'd');            // FYI banner → id 43, independent
    expect(procs[1].args.some((a) => a.startsWith('--replace-id='))).toBe(false); // did NOT replace 42
    expect(procs[0].killed).toBe(false); // the waiting waiter is untouched by an info banner
    await n.clear();                   // closes the WAITING slot (42), not the banner
    const [, args] = gdbus.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('42');
    expect(args).not.toContain('43');
  });

  it('info() wires the click-to-open action just like ping()', async () => {
    const { procs, ss } = fakeProcs();
    const run = vi.fn();
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, spawner: noopSpawner, action: { label: 'Open dashboard', run } });
    await n.info('myproj · Turn finished', 'done');
    expect(procs[0].args).toContain('--action=answer=Open dashboard');
    procs[0].emit('answer');
    expect(run).toHaveBeenCalledOnce();
  });

  it('is a silent no-op when disabled / on unsupported platforms / without notify-send', async () => {
    const { procs, ss } = fakeProcs();
    const sp = vi.fn(async () => '');
    await createDesktopNotifier({ ...linux, enabled: false, streamSpawner: ss, spawner: sp }).ping('t', 'b');
    await createDesktopNotifier({ platform: 'freebsd', hasCmd: () => true, streamSpawner: ss, spawner: sp }).ping('t', 'b');
    await createDesktopNotifier({ platform: 'linux', hasCmd: () => false, streamSpawner: ss, spawner: sp }).ping('t', 'b');
    expect(procs).toHaveLength(0);
    expect(sp).not.toHaveBeenCalled();
  });
});

describe('resident waiting toast', () => {
  it('never expires and never goes transient — you must still see it after a coffee break', async () => {
    const calls: string[][] = [];
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd: () => true,
      spawner: async () => '',
      streamSpawner: (_cmd, args) => {
        calls.push(args);
        return { firstLine: Promise.resolve('7'), onLine: () => undefined, kill: () => undefined };
      },
    });
    await n.render('proj · Bash', 'Approval needed — click to open and answer');
    expect(calls[0]).toContain('--expire-time=0');
    expect(calls[0]!.some((a) => a.includes('transient'))).toBe(false);
  });

  it('render replaces the previous toast instead of stacking a second one', async () => {
    const calls: string[][] = [];
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd: () => true,
      spawner: async () => '',
      streamSpawner: (_cmd, args) => {
        calls.push(args);
        return { firstLine: Promise.resolve('7'), onLine: () => undefined, kill: () => undefined };
      },
    });
    await n.render('a', 'b');
    await n.render('c', 'd');
    expect(calls[0]!.some((a) => a.startsWith('--replace-id'))).toBe(false);
    expect(calls[1]).toContain('--replace-id=7');
  });
});

describe('toast id survives a daemon restart', () => {
  const makeStore = (seed: string | null = null) => {
    let v = seed;
    return { read: () => v, write: (id: string | null) => { v = id; }, peek: () => v };
  };

  it('a fresh notifier can close a toast the previous process left behind', async () => {
    const store = makeStore('42');
    const closed: string[][] = [];
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd: () => true, idStore: store,
      spawner: async (_cmd, args) => { closed.push(args); return ''; },
      streamSpawner: () => ({ firstLine: Promise.resolve('9'), onLine: () => undefined, kill: () => undefined }),
    });
    await n.clear();
    // Without the seed this returns early and never reaches gdbus.
    expect(closed[0]).toContain('42');
    expect(store.peek()).toBeNull();
  });

  it('persists null only AFTER the close resolves, so a mid-clear crash leaves the stale id (not a lost one) on disk', async () => {
    const events: string[] = [];
    const store = {
      read: () => '42' as string | null,
      write: (id: string | null) => { events.push(`write(${id === null ? 'null' : id})`); },
    };
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd: () => true, idStore: store,
      spawner: async (_cmd, args) => { events.push(`gdbus(${args[args.length - 1]})`); return ''; },
      streamSpawner: () => ({ firstLine: Promise.resolve('9'), onLine: () => undefined, kill: () => undefined }),
    });
    await n.clear();
    expect(events).toEqual(['gdbus(42)', 'write(null)']);
  });

  it('rendering records the new id so the NEXT process can close it', async () => {
    const store = makeStore();
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd: () => true, idStore: store,
      spawner: async () => '',
      streamSpawner: () => ({ firstLine: Promise.resolve('7'), onLine: () => undefined, kill: () => undefined }),
    });
    await n.render('t', 'b');
    expect(store.peek()).toBe('7');
  });

  it('works with no store at all — persistence is optional, not required', async () => {
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd: () => true,
      spawner: async () => '',
      streamSpawner: () => ({ firstLine: Promise.resolve('7'), onLine: () => undefined, kill: () => undefined }),
    });
    await expect(n.render('t', 'b')).resolves.toBeUndefined();
    await expect(n.clear()).resolves.toBeUndefined();
  });
});

describe('vitest backstop', () => {
  it('returns a no-op notifier under vitest when no spawner is injected', async () => {
    // Guards the developer's real desktop: 35 bootstrap tests never inject the
    // seam, and used to reach real notify-send with fixture session names.
    const n = createDesktopNotifier({ platform: 'linux', hasCmd: () => true });
    await expect(n.render('t', 'b')).resolves.toBeUndefined();
    await expect(n.clear()).resolves.toBeUndefined();
  });

  it('an injected spawner still exercises the REAL implementation under vitest', async () => {
    const calls: string[][] = [];
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd: () => true,
      spawner: async () => '',
      streamSpawner: (_cmd, args) => {
        calls.push(args);
        return { firstLine: Promise.resolve('1'), onLine: () => undefined, kill: () => undefined };
      },
    });
    await n.render('t', 'b');
    expect(calls).toHaveLength(1);
  });
});

describe('darwin backend (osascript, ping-only)', () => {
  it('pings via display notification with escaped quotes; clear is a no-op', async () => {
    const calls: Array<[string, string[]]> = [];
    const sp = async (cmd: string, args: string[]) => { calls.push([cmd, args]); return ''; };
    const n = createDesktopNotifier({ platform: 'darwin', hasCmd: () => true, spawner: sp });
    await n.ping('tlive · Bash', 'say "hi"');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('osascript');
    expect(calls[0][1][1]).toBe('display notification "say \\"hi\\"" with title "tlive · Bash"');
    await n.clear();
    expect(calls).toHaveLength(1); // not scriptable on macOS
  });

  it('info() is just another display notification (no slot on macOS)', async () => {
    const calls: Array<[string, string[]]> = [];
    const sp = async (cmd: string, args: string[]) => { calls.push([cmd, args]); return ''; };
    const n = createDesktopNotifier({ platform: 'darwin', hasCmd: () => true, spawner: sp });
    await n.info('myproj · Turn finished', 'done');
    expect(calls[0][0]).toBe('osascript');
    expect(calls[0][1][1]).toContain('display notification "done" with title "myproj · Turn finished"');
  });
});

describe('win32 backend (PowerShell WinRT toast)', () => {
  it('pings a tagged toast (single slot) and clears via History.Remove', async () => {
    const calls: Array<[string, string[]]> = [];
    const sp = async (cmd: string, args: string[]) => { calls.push([cmd, args]); return ''; };
    const n = createDesktopNotifier({ platform: 'win32', hasCmd: () => true, spawner: sp });
    await n.ping('tlive · Bash', 'a<b>&"c"');
    expect(calls[0][0]).toBe('powershell');
    const script = calls[0][1][calls[0][1].length - 1];
    expect(script).toContain("$t.Tag = 'tlive'");
    expect(script).toContain('a&lt;b&gt;&amp;&quot;c&quot;'); // XML-escaped body
    await n.clear();
    const clearScript = calls[1][1][calls[1][1].length - 1];
    expect(clearScript).toContain("History.Remove('tlive', 'tlive'");
  });

  it('info() uses a distinct tag so clearing the waiting slot never nukes the FYI banner', async () => {
    const calls: Array<[string, string[]]> = [];
    const sp = async (cmd: string, args: string[]) => { calls.push([cmd, args]); return ''; };
    const n = createDesktopNotifier({ platform: 'win32', hasCmd: () => true, spawner: sp });
    await n.info('myproj · Turn finished', 'done');
    const script = calls[0][1][calls[0][1].length - 1];
    expect(script).toContain("$t.Tag = 'tlive-info'");
    expect(script).not.toContain("$t.Tag = 'tlive'");
  });

  it('degrades to a no-op without powershell on PATH', async () => {
    const sp = vi.fn(async () => '');
    await createDesktopNotifier({ platform: 'win32', hasCmd: () => false, spawner: sp }).ping('t', 'b');
    expect(sp).not.toHaveBeenCalled();
  });
});
