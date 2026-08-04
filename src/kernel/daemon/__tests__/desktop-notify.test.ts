import { describe, it, expect, vi } from 'vitest';
import { createDesktopNotifier, type NotifySendProc, type StreamSpawner } from '../desktop-notify';

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
    const proc: NotifySendProc = {
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

  it('renders via notify-send with app name, resident expiry, and no transient hint (the toast must survive a coffee break, not evaporate)', async () => {
    const { procs, ss } = fakeProcs();
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, spawner: noopSpawner });
    await n.render('tlive · Bash', 'Waiting for approval');
    expect(procs).toHaveLength(1);
    expect(procs[0].cmd).toBe('notify-send');
    expect(procs[0].args).toContain('--app-name=tlive');
    expect(procs[0].args).toContain('--expire-time=0');
    expect(procs[0].args.some((a) => a.includes('transient'))).toBe(false);
    expect(procs[0].args).toContain('tlive · Bash');
    expect(procs[0].args).toContain('Waiting for approval');
    expect(procs[0].args.some((a) => a.startsWith('--action='))).toBe(false); // no action configured
  });

  it('occupies a single notification slot: second render replaces the first (--replace-id) and kills the superseded waiter', async () => {
    const { procs, ss } = fakeProcs();
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, spawner: noopSpawner });
    await n.render('a', 'b');
    await n.render('c', 'd');
    expect(procs[0].args).toContain('--print-id');
    expect(procs[0].args.some((a) => a.startsWith('--replace-id='))).toBe(false);
    expect(procs[1].args).toContain('--replace-id=42');
    expect(procs[0].killed).toBe(true);
  });

  it('click-to-answer: the action button runs the callback; a superseded process click is ignored', async () => {
    const { procs, ss } = fakeProcs();
    const run = vi.fn();
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, spawner: noopSpawner, action: { label: 'Open dashboard', run } });
    await n.render('a', 'b');
    expect(procs[0].args).toContain('--action=answer=Open dashboard');
    await n.render('c', 'd'); // supersedes the first
    procs[0].emit('answer'); // stale click from the replaced waiter
    expect(run).not.toHaveBeenCalled();
    procs[1].emit('answer'); // live click
    expect(run).toHaveBeenCalledOnce();
  });

  it('clear() closes the live notification over DBus, kills the waiter, and forgets the id', async () => {
    const { procs, ss } = fakeProcs();
    const gdbus = vi.fn(async () => '');
    const n = createDesktopNotifier({ ...linux, streamSpawner: ss, spawner: gdbus });
    await n.render('a', 'b');
    await n.clear();
    expect(gdbus).toHaveBeenCalledOnce();
    const [cmd, args] = gdbus.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('gdbus');
    expect(args).toContain('org.freedesktop.Notifications.CloseNotification');
    expect(args).toContain('42');
    expect(procs[0].killed).toBe(true);
    // Next render starts a fresh slot — no --replace-id pointing at a closed toast.
    await n.render('c', 'd');
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
    await n.render('a', 'b');
    await n.render('c', 'd');
    expect(argsSeen[1].some((a) => a.startsWith('--replace-id='))).toBe(false);
  });

  it('is a silent no-op when disabled / on unsupported platforms / without notify-send', async () => {
    const { procs, ss } = fakeProcs();
    const sp = vi.fn(async () => '');
    await createDesktopNotifier({ ...linux, enabled: false, streamSpawner: ss, spawner: sp }).render('t', 'b');
    await createDesktopNotifier({ platform: 'freebsd', hasCmd: () => true, streamSpawner: ss, spawner: sp }).render('t', 'b');
    await createDesktopNotifier({ platform: 'linux', hasCmd: () => false, streamSpawner: ss, spawner: sp }).render('t', 'b');
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

describe('a new waiting thing raises a banner', () => {
  const linux = (calls: string[][], closes: string[][]) => createDesktopNotifier({
    platform: 'linux', hasCmd: () => true,
    spawner: async (_cmd, args) => { closes.push(args); return ''; },
    streamSpawner: (_cmd, args) => {
      calls.push(args);
      return { firstLine: Promise.resolve(String(100 + calls.length)), onLine: () => undefined, kill: () => undefined };
    },
  });

  it('alert posts a FRESH notification — a replaced one never pops on a persistent server', async () => {
    const calls: string[][] = []; const closes: string[][] = [];
    const n = linux(calls, closes);
    await n.render('a', 'b');                      // first: nothing to replace
    await n.render('c', 'd', { alert: true });     // must NOT carry --replace-id
    expect(calls[1]!.some((a) => a.startsWith('--replace-id'))).toBe(false);
  });

  it('alert closes the previous notification BEFORE posting, so nothing is orphaned', async () => {
    const order: string[] = []; const calls: string[][] = [];
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd: () => true,
      spawner: async (_cmd, args) => { order.push(`close(${args.at(-1)})`); return ''; },
      streamSpawner: (_cmd, args) => {
        calls.push(args); order.push('post');
        return { firstLine: Promise.resolve(String(100 + calls.length)), onLine: () => undefined, kill: () => undefined };
      },
    });
    await n.render('a', 'b');
    order.length = 0;
    await n.render('c', 'd', { alert: true });
    expect(order).toEqual(['close(101)', 'post']);
  });

  it('without alert it still replaces in place — answering one of several must not re-pop', async () => {
    const calls: string[][] = []; const closes: string[][] = [];
    const n = linux(calls, closes);
    await n.render('a', 'b');
    await n.render('c', 'd');
    expect(calls[1]).toContain('--replace-id=101');
    expect(closes).toHaveLength(0);
  });

  // Coverage gap flagged in review round 1: none of the three tests above
  // inject an idStore while alerting, so a regression in the close-branch
  // that stopped persisting the fresh id (e.g. an early return added inside
  // `if (alert && lastId)`) would leave a killed daemon's toast unclosable
  // again — the exact bug an earlier task already fixed once — with nothing
  // in the suite to catch it.
  it('alert persists the NEW id after closing the old one — a killed daemon must still be able to close the fresh toast', async () => {
    let stored: string | null = '999'; // seeded as if a previous process left this toast up
    const idStore = { read: () => stored, write: (id: string | null) => { stored = id; } };
    const calls: string[][] = []; const closes: string[][] = [];
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd: () => true, idStore,
      spawner: async (_cmd, args) => { closes.push(args); return ''; },
      streamSpawner: (_cmd, args) => {
        calls.push(args);
        return { firstLine: Promise.resolve(String(200 + calls.length)), onLine: () => undefined, kill: () => undefined };
      },
    });
    await n.render('a', 'b', { alert: true });
    expect(closes).toHaveLength(1);
    expect(closes[0]).toContain('999'); // the OLD id was closed
    expect(stored).toBe('201');         // the store now holds the NEW id — not '999', not null
  });
});

describe('vitest backstop', () => {
  it('returns a no-op notifier under vitest when no spawner is injected', async () => {
    // Guards the developer's real desktop: 35 bootstrap tests never inject the
    // seam, and used to reach real notify-send with fixture session names.
    //
    // Asserting render()/clear() resolve to undefined is NOT enough to catch a
    // regressed backstop (M2): if the VITEST guard ever stopped short-circuiting,
    // this call would fall through to `platform: 'linux', hasCmd: () => true`
    // and fire a genuine notify-send on the developer's desktop — while
    // render()/clear() would STILL resolve to undefined either way (notify-send
    // is fire-and-forget from the caller's perspective), so those two
    // assertions alone can never fail even when the backstop is broken. A
    // `hasCmd` spy can: the no-op path returns before any platform branching,
    // so it is provably never consulted — same pattern as the sibling "silent
    // no-op" test below (`expect(sp).not.toHaveBeenCalled()`). The `desktop.channel`
    // log line (Task 10) is a USEFUL extra signal — a regressed backstop would
    // also show up there as `active: true` — but it is a self-reported string,
    // not a structural guarantee, so it augments this assertion rather than
    // replacing it.
    const hasCmd = vi.fn(() => true);
    const lines: Array<{ fields: Record<string, unknown> }> = [];
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd,
      log: (_msg, fields) => { lines.push({ fields }); },
    });
    await expect(n.render('t', 'b')).resolves.toBeUndefined();
    await expect(n.clear()).resolves.toBeUndefined();
    expect(hasCmd).not.toHaveBeenCalled();
    expect(lines).toEqual([{ fields: { active: false, platform: 'linux', reason: 'vitest' } }]);
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

describe('channel observability (Task 10) — the one line that answers "why do I never get toasts"', () => {
  it('reports once whether the channel is live, and why not when it is not', async () => {
    const lines: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const log = (msg: string, fields: Record<string, unknown>): void => { lines.push({ msg, fields }); };
    // `spawner` is this file's documented "I am testing the real
    // implementation" signal (see the vitest-backstop guard below) — without
    // it, the vitest-no-spawner backstop fires FIRST under `pnpm test` and
    // this call would report `reason: 'vitest'` instead of ever consulting
    // `hasCmd`, proving nothing about the no-notify-send path.
    createDesktopNotifier({ platform: 'linux', hasCmd: () => false, spawner: async () => '', log });
    expect(lines).toEqual([{ msg: 'desktop.channel', fields: { active: false, platform: 'linux', reason: 'no-notify-send' } }]);
  });

  it('reports an active channel exactly once, not per render', async () => {
    const lines: string[] = [];
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd: () => true,
      log: (msg) => { lines.push(msg); },
      spawner: async () => '',
      streamSpawner: () => ({ firstLine: Promise.resolve('7'), onLine: () => undefined, kill: () => undefined }),
    });
    await n.render('a', 'b');
    await n.render('c', 'd');
    expect(lines).toEqual(['desktop.channel']);
  });

  it('reports disabled and vitest no-ops with their own reasons, not silently', async () => {
    const lines: Array<{ fields: Record<string, unknown> }> = [];
    const log = (_msg: string, fields: Record<string, unknown>): void => { lines.push({ fields }); };
    createDesktopNotifier({ platform: 'linux', hasCmd: () => true, enabled: false, log });
    // No spawner injected → the VITEST backstop fires (this suite runs under vitest).
    createDesktopNotifier({ platform: 'linux', hasCmd: () => true, log });
    expect(lines).toEqual([
      { fields: { active: false, platform: 'linux', reason: 'disabled' } },
      { fields: { active: false, platform: 'linux', reason: 'vitest' } },
    ]);
  });

  it('reports unsupported-platform for a platform with no backend at all', async () => {
    const lines: Array<{ fields: Record<string, unknown> }> = [];
    const log = (_msg: string, fields: Record<string, unknown>): void => { lines.push({ fields }); };
    // Same reason a spawner is injected above: the vitest backstop fires
    // before ANY platform check, regardless of platform, so without it this
    // would report 'vitest' rather than exercising the platform branch at all.
    createDesktopNotifier({ platform: 'freebsd', hasCmd: () => true, spawner: async () => '', log });
    expect(lines).toEqual([{ fields: { active: false, platform: 'freebsd', reason: 'unsupported-platform' } }]);
  });

  it('reports no-backend (not the linux-only no-notify-send) when darwin/win32 are missing their own binary', async () => {
    const lines: Array<{ fields: Record<string, unknown> }> = [];
    const log = (_msg: string, fields: Record<string, unknown>): void => { lines.push({ fields }); };
    createDesktopNotifier({ platform: 'darwin', hasCmd: () => false, spawner: async () => '', log });
    createDesktopNotifier({ platform: 'win32', hasCmd: () => false, spawner: async () => '', log });
    expect(lines).toEqual([
      { fields: { active: false, platform: 'darwin', reason: 'no-backend' } },
      { fields: { active: false, platform: 'win32', reason: 'no-backend' } },
    ]);
  });
});

describe('darwin backend (osascript, no slot)', () => {
  it('renders via display notification with escaped quotes; clear is a no-op', async () => {
    const calls: Array<[string, string[]]> = [];
    const sp = async (cmd: string, args: string[]) => { calls.push([cmd, args]); return ''; };
    const n = createDesktopNotifier({ platform: 'darwin', hasCmd: () => true, spawner: sp });
    await n.render('tlive · Bash', 'say "hi"', { alert: true });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('osascript');
    expect(calls[0][1][1]).toBe('display notification "say \\"hi\\"" with title "tlive · Bash"');
    await n.clear();
    expect(calls).toHaveLength(1); // not scriptable on macOS
  });
});

describe('win32 backend (PowerShell WinRT toast)', () => {
  it('renders a tagged toast (single slot) and clears via History.Remove', async () => {
    const calls: Array<[string, string[]]> = [];
    const sp = async (cmd: string, args: string[]) => { calls.push([cmd, args]); return ''; };
    const n = createDesktopNotifier({ platform: 'win32', hasCmd: () => true, spawner: sp });
    await n.render('tlive · Bash', 'a<b>&"c"');
    expect(calls[0][0]).toBe('powershell');
    const script = calls[0][1][calls[0][1].length - 1];
    expect(script).toContain("$t.Tag = 'tlive'");
    expect(script).toContain('a&lt;b&gt;&amp;&quot;c&quot;'); // XML-escaped body
    await n.clear();
    const clearScript = calls[1][1][calls[1][1].length - 1];
    expect(clearScript).toContain("History.Remove('tlive', 'tlive'");
  });

  it('degrades to a no-op without powershell on PATH', async () => {
    const sp = vi.fn(async () => '');
    await createDesktopNotifier({ platform: 'win32', hasCmd: () => false, spawner: sp }).render('t', 'b');
    expect(sp).not.toHaveBeenCalled();
  });
});

describe('alert on darwin', () => {
  const mac = (calls: string[][]) => createDesktopNotifier({
    platform: 'darwin', hasCmd: () => true,
    spawner: async (_cmd, args) => { calls.push(args); return ''; },
  });

  it('a new waiting thing posts a banner', async () => {
    const calls: string[][] = [];
    await mac(calls).render('t', 'b', { alert: true });
    expect(calls).toHaveLength(1);
  });

  it('a silent update posts NOTHING — macOS cannot update in place, and a fresh banner would be wrong', async () => {
    const calls: string[][] = [];
    const n = mac(calls);
    await n.render('t', 'b', { alert: true });
    await n.render('t2', 'b2', { alert: false });
    expect(calls).toHaveLength(1);
  });

  it('an omitted alert flag is treated as silent', async () => {
    const calls: string[][] = [];
    await mac(calls).render('t', 'b');
    expect(calls).toHaveLength(0);
  });
});

describe('alert on win32', () => {
  const win = (scripts: string[]) => createDesktopNotifier({
    platform: 'win32', hasCmd: () => true,
    spawner: async (_cmd, args) => { scripts.push(args.at(-1) ?? ''); return ''; },
  });

  it('a new waiting thing removes the old toast first, so the banner is guaranteed', async () => {
    const scripts: string[] = [];
    await win(scripts).render('t', 'b', { alert: true });
    expect(scripts[0]).toContain('History.Remove');
    expect(scripts[0]!.indexOf('History.Remove')).toBeLessThan(scripts[0]!.indexOf('.Show('));
    expect(scripts[0]).not.toContain('SuppressPopup');
  });

  it('a silent update suppresses the popup instead of re-raising it', async () => {
    const scripts: string[] = [];
    await win(scripts).render('t', 'b', { alert: false });
    expect(scripts[0]).toContain('SuppressPopup = $true');
    expect(scripts[0]).not.toContain('History.Remove');
  });

  it('clear() still removes the toast from the Action Center', async () => {
    const scripts: string[] = [];
    await win(scripts).clear();
    expect(scripts[0]).toContain('History.Remove');
  });
});
