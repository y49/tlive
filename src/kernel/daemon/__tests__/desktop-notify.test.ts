import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDesktopNotifier, type Spawner } from '../desktop-notify.js';

describe('createDesktopNotifier', () => {
  const linux = { platform: 'linux' as const, hasCmd: () => true };

  it('is a silent no-op when disabled / on unsupported platforms / without notify-send', async () => {
    const sp = vi.fn(async () => {});
    await createDesktopNotifier({ ...linux, enabled: false, spawner: sp }).notify('t', 'b');
    await createDesktopNotifier({ platform: 'freebsd', hasCmd: () => true, spawner: sp }).notify('t', 'b');
    await createDesktopNotifier({ platform: 'linux', hasCmd: () => false, spawner: sp }).notify('t', 'b');
    expect(sp).not.toHaveBeenCalled();
  });
});

describe('vitest backstop', () => {
  it('returns a no-op notifier under vitest when no spawner is injected', async () => {
    // Guards the developer's real desktop: 35 bootstrap tests never inject the
    // seam, and used to reach real notify-send with fixture session names.
    //
    // Asserting notify() resolves to undefined is NOT enough to catch a
    // regressed backstop (M2): if the VITEST guard ever stopped short-circuiting,
    // this call would fall through to `platform: 'linux', hasCmd: () => true`
    // and fire a genuine notify-send on the developer's desktop — while
    // notify() would STILL resolve to undefined either way (notify-send is
    // fire-and-forget from the caller's perspective), so that assertion alone
    // can never fail even when the backstop is broken. A `hasCmd` spy can: the
    // no-op path returns before any platform branching, so it is provably
    // never consulted — same pattern as the sibling "silent no-op" test above
    // (`expect(sp).not.toHaveBeenCalled()`). The `desktop.channel` log line
    // (Task 10) is a USEFUL extra signal — a regressed backstop would also
    // show up there as `active: true` — but it is a self-reported string, not
    // a structural guarantee, so it augments this assertion rather than
    // replacing it.
    const hasCmd = vi.fn(() => true);
    const lines: Array<{ fields: Record<string, unknown> }> = [];
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd,
      log: (_msg, fields) => { lines.push({ fields }); },
    });
    await expect(n.notify('t', 'b')).resolves.toBeUndefined();
    expect(hasCmd).not.toHaveBeenCalled();
    expect(lines).toEqual([{ fields: { active: false, platform: 'linux', reason: 'vitest' } }]);
  });

  it('an injected spawner still exercises the REAL implementation under vitest', async () => {
    const calls: string[][] = [];
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd: () => true,
      spawner: async (cmd, args) => { if (cmd === 'notify-send') calls.push(args); },
    });
    await n.notify('t', 'b');
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

  it('reports an active channel exactly once, not per notify', async () => {
    const lines: string[] = [];
    const n = createDesktopNotifier({
      platform: 'linux', hasCmd: () => true,
      log: (msg) => { lines.push(msg); },
      spawner: async () => '7',
    });
    await n.notify('a', 'b');
    await n.notify('c', 'd');
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

describe('notify — one notification per waiting thing', () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawner: Spawner = async (cmd, args) => {
    calls.push({ cmd, args });
  };
  beforeEach(() => { calls.length = 0; });

  it('linux: one notify-send per call, with no slot flags at all', async () => {
    const n = createDesktopNotifier({ platform: 'linux', hasCmd: () => true, spawner });
    await n.notify('drama-admin · 等你批准', 'Bash · pnpm build');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('notify-send');
    expect(calls[0]!.args).toEqual(['--app-name=tlive', 'drama-admin · 等你批准', 'Bash · pnpm build']);
  });

  it('linux: no --print-id, --replace-id, --expire-time or transient hint — there is no slot to keep', async () => {
    const n = createDesktopNotifier({ platform: 'linux', hasCmd: () => true, spawner });
    await n.notify('a', 'b');
    await n.notify('c', 'd');
    const flat = calls.flatMap((c) => c.args).join(' ');
    expect(flat).not.toContain('--print-id');
    expect(flat).not.toContain('--replace-id');
    expect(flat).not.toContain('--expire-time');
    expect(flat).not.toContain('transient');
    expect(calls.every((c) => c.cmd === 'notify-send')).toBe(true);
    expect(calls).toHaveLength(2); // never a gdbus close between them
  });

  it('darwin: posts every time — the old model silently posted NOTHING for a non-alert', async () => {
    const n = createDesktopNotifier({ platform: 'darwin', hasCmd: () => true, spawner });
    await n.notify('t', 'b');
    await n.notify('t2', 'b2');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toBe('osascript');
    expect(calls[0]!.args.join(' ')).toContain('display notification "b" with title "t"');
  });

  it('win32: shows a toast with no Tag, Group, History or SuppressPopup — nothing to replace', async () => {
    const n = createDesktopNotifier({ platform: 'win32', hasCmd: () => true, spawner });
    await n.notify('t', 'b');
    expect(calls).toHaveLength(1);
    const script = calls[0]!.args.join(' ');
    expect(script).toContain('Show');
    expect(script).not.toContain('History.Remove');
    expect(script).not.toContain('SuppressPopup');
    expect(script).not.toContain('$t.Tag');
  });

  it('a missing backend is a silent no-op, on every platform', async () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const n = createDesktopNotifier({ platform, hasCmd: () => false, spawner });
      await n.notify('t', 'b');
    }
    expect(calls).toHaveLength(0);
  });
});
