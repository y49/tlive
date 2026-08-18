import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { ensureCodexAppServer, codexAppServerSockPath, appServerSpawnOptions } from '../spawn.js';

const fakeChild = () => Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn(), unref: vi.fn() });

describe('ensureCodexAppServer', () => {
  it('adopts an already-listening socket without spawning', async () => {
    const spawnFn = vi.fn();
    const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => true, spawnFn: spawnFn as any, platform: 'linux', hasCodex: () => true });
    expect(c).toMatchObject({ adopted: true });
    expect(spawnFn).not.toHaveBeenCalled();
    c!.stop(); // no-op, must not throw
  });
  it('spawns when the socket is absent and keeps trying until one answers', async () => {
    vi.useFakeTimers();
    try {
      const children: any[] = [];
      const spawnFn = vi.fn(() => { const ch = fakeChild(); children.push(ch); return ch; });
      const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => false, spawnFn: spawnFn as any, platform: 'linux', hasCodex: () => true });
      expect(c).toMatchObject({ adopted: false });
      expect(spawnFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1100);
      expect(spawnFn).toHaveBeenCalledTimes(2);
      c!.stop();
      await vi.advanceTimersByTimeAsync(60_000); // stop() 后不得再拉
      expect(spawnFn).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('revives an ADOPTED app-server that dies — supervision is not limited to our own child', async () => {
    // The gap this closes: `tlive stop/start` now always re-adopts rather than
    // replacing, so "adopted" is the normal case, and an adopted instance used
    // to be watched by nobody. Killing it left no app-server, no companion, and
    // a `tlive status` still claiming one was running.
    vi.useFakeTimers();
    try {
      let alive = true;
      const spawnFn = vi.fn(() => { alive = true; return fakeChild(); }); // a spawn that works
      const states: string[] = [];
      const c = await ensureCodexAppServer({
        logPath: '/tmp/x.log', probe: async () => alive, spawnFn: spawnFn as any,
        onStateChange: (s) => states.push(s), platform: 'linux', hasCodex: () => true,
      });
      expect(c).toMatchObject({ adopted: true });
      expect(spawnFn).not.toHaveBeenCalled();
      alive = false;                              // someone killed it
      await vi.advanceTimersByTimeAsync(16_000);  // one health interval
      expect(spawnFn).toHaveBeenCalledTimes(1);   // …and tlive puts one back
      expect(alive).toBe(true);
      expect(states).toEqual(['running']);        // never stopped being true
      c!.stop();
    } finally { vi.useRealTimers(); }
  });
  it('stop() leaves the app-server running — killing it orphans live Codex TUIs', async () => {
    const children: any[] = [];
    const spawnFn = vi.fn(() => { const ch = fakeChild(); children.push(ch); return ch; });
    const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => false, spawnFn: spawnFn as any, platform: 'linux', hasCodex: () => true });
    c!.stop();
    expect(children[0].kill).not.toHaveBeenCalled();
  });
  it('unrefs the child so the daemon neither waits for it nor drags it down', async () => {
    const children: any[] = [];
    const spawnFn = vi.fn(() => { const ch = fakeChild(); children.push(ch); return ch; });
    const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => false, spawnFn: spawnFn as any, platform: 'linux', hasCodex: () => true });
    expect(children[0].unref).toHaveBeenCalled();
    c!.stop();
  });
  it('spawn options detach the app-server from the daemon process group', () => {
    // Mirrors what Codex itself does for its own managed backend
    // (app-server-daemon/src/backend/pid.rs: Stdio::null + pre_exec setsid).
    expect(appServerSpawnOptions(7)).toMatchObject({ detached: true, stdio: ['ignore', 7, 7] });
  });
  it('reports degraded after repeated failures but never stops trying', async () => {
    // `degraded` used to be terminal: the supervisor stopped scheduling and only
    // a daemon restart revived it. That is precisely the uninstall shape - the
    // codex binary leaves PATH, every respawn fails instantly, the budget burns
    // in under a minute, and reinstalling codex changed nothing.
    vi.useFakeTimers();
    try {
      const states: string[] = [];
      const spawnFn = vi.fn(() => fakeChild());
      const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => false, spawnFn: spawnFn as any, onStateChange: (s) => states.push(s), platform: 'linux', hasCodex: () => true });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(states.at(-1)).toBe('degraded');
      const givenUpAt = spawnFn.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(spawnFn.mock.calls.length).toBeGreaterThan(givenUpAt); // still trying
      c!.stop();
    } finally { vi.useRealTimers(); }
  });

  it('recovers on its own once codex is reinstalled', async () => {
    // The exact sequence that broke: uninstall codex, reinstall it, do NOT
    // restart tlive.
    vi.useFakeTimers();
    try {
      let codexInstalled = true;
      let listening = false;
      const states: string[] = [];
      const spawnFn = vi.fn(() => { listening = codexInstalled; return fakeChild(); });
      const c = await ensureCodexAppServer({
        logPath: '/tmp/x.log', probe: async () => listening, spawnFn: spawnFn as any,
        onStateChange: (s) => states.push(s), platform: 'linux', hasCodex: () => codexInstalled,
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(states.at(-1)).toBe('running');

      codexInstalled = false;   // uninstall takes the app-server with it
      listening = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(states.at(-1)).toBe('off');   // codex is gone: not a fault, just absent
      // Nothing to spawn, so it does not thrash trying.
      const attemptsWhileMissing = spawnFn.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawnFn.mock.calls.length).toBe(attemptsWhileMissing);

      codexInstalled = true;    // reinstall, WITHOUT restarting tlive
      await vi.advanceTimersByTimeAsync(20_000);
      expect(states.at(-1)).toBe('running');
      c!.stop();
    } finally { vi.useRealTimers(); }
  });
  it('a spawn that throws does not end the loop — that would be the give-up bug again', async () => {
    // defaultSpawnFn opens the log file first, so EACCES / ENOSPC / EMFILE all
    // throw SYNCHRONOUSLY out of the tick. An escaping throw skips the
    // reschedule at the end of the tick, which is the exact failure this whole
    // supervisor exists to prevent, arriving through a different door.
    vi.useFakeTimers();
    try {
      let broken = true;
      const spawnFn = vi.fn(() => { if (broken) throw new Error('EACCES /var/log'); return fakeChild(); });
      const states: string[] = [];
      const c = await ensureCodexAppServer({
        logPath: '/tmp/x.log', probe: async () => false, spawnFn: spawnFn as any,
        onStateChange: (s) => states.push(s), platform: 'linux', hasCodex: () => true,
      });
      const attempts = spawnFn.mock.calls.length;
      expect(attempts).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(spawnFn.mock.calls.length).toBeGreaterThan(attempts); // still trying
      broken = false;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(states.at(-1)).toBeDefined();
      c!.stop();
    } finally { vi.useRealTimers(); }
  });

  it('a probe that rejects does not end the loop either', async () => {
    vi.useFakeTimers();
    try {
      const spawnFn = vi.fn(() => fakeChild());
      const c = await ensureCodexAppServer({
        logPath: '/tmp/x.log', probe: async () => { throw new Error('EMFILE'); },
        spawnFn: spawnFn as any, platform: 'linux', hasCodex: () => true,
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(c).not.toBeNull();
      c!.stop();
    } finally { vi.useRealTimers(); }
  });

  it('stop() during an in-flight health check spawns nothing', async () => {
    // The stopped-check at the top of the tick is not enough: stop() can land
    // while the probe is still awaiting, and the code after the await would
    // then start an app-server the daemon has already finished with.
    vi.useFakeTimers();
    try {
      let release: (v: boolean) => void = () => {};
      const gate = new Promise<boolean>((r) => { release = r; });
      let probes = 0;
      const spawnFn = vi.fn(() => fakeChild());
      const c = await ensureCodexAppServer({
        logPath: '/tmp/x.log',
        // Startup settles normally; the NEXT scheduled check is the one we hold
        // open across stop().
        probe: () => { probes += 1; return probes <= 1 ? Promise.resolve(false) : gate; },
        spawnFn: spawnFn as any, platform: 'linux', hasCodex: () => true,
      });
      await vi.advanceTimersByTimeAsync(1100); // the held check begins
      const before = spawnFn.mock.calls.length;
      c!.stop();
      release(false);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(spawnFn.mock.calls.length).toBe(before);
    } finally { vi.useRealTimers(); }
  });

  it("a child's async spawn error does not crash the daemon", async () => {
    // ENOENT TOCTOU / EACCES / EMFILE emit 'error' and never 'exit'. With no
    // listener that is an uncaught exception. Recovery itself is the probe
    // loop's job, not this listener's.
    vi.useFakeTimers();
    try {
      const children: any[] = [];
      const spawnFn = vi.fn(() => { const ch = fakeChild(); children.push(ch); return ch; });
      const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => false, spawnFn: spawnFn as any, platform: 'linux', hasCodex: () => true });
      expect(() => children[0].emit('error', new Error('EACCES'))).not.toThrow();
      expect(() => children[0].emit('exit', 1)).not.toThrow();
      c!.stop();
    } finally { vi.useRealTimers(); }
  });
  it('signals running via onStateChange when adopting an already-listening socket', async () => {
    const spawnFn = vi.fn();
    const states: string[] = [];
    const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => true, spawnFn: spawnFn as any, onStateChange: (s) => states.push(s), platform: 'linux', hasCodex: () => true });
    expect(c).toMatchObject({ adopted: true });
    expect(states).toEqual(['running']);
  });
  it('sock path honors CODEX_HOME arg', () => {
    expect(codexAppServerSockPath('/ch')).toBe(join('/ch', 'app-server-control', 'app-server-control.sock'));
  });
  it('returns null on win32 — the feature does not exist there, so there is nothing to watch for', async () => {
    const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => true, platform: 'win32', hasCodex: () => true });
    expect(c).toBeNull();
  });
  it('keeps watching when codex is missing from PATH, and reports off rather than degraded', async () => {
    // Returning null here was the last permanent give-up: install codex after
    // the daemon started and tlive never noticed until a restart. `off` is a
    // stable, correct state — nothing is wrong, the product just is not
    // installed — so it must not read as a failure to the majority of users
    // who will never install Codex.
    vi.useFakeTimers();
    try {
      let codexInstalled = false;
      let listening = false;
      const states: string[] = [];
      const spawnFn = vi.fn(() => { listening = codexInstalled; return fakeChild(); });
      const c = await ensureCodexAppServer({
        logPath: '/tmp/x.log', probe: async () => listening, spawnFn: spawnFn as any,
        onStateChange: (s) => states.push(s), platform: 'linux', hasCodex: () => codexInstalled,
      });
      expect(c).not.toBeNull();
      expect(states).toEqual(['off']);
      expect(spawnFn).not.toHaveBeenCalled();   // nothing to spawn, so no thrashing

      codexInstalled = true;                    // installed later, no tlive restart
      await vi.advanceTimersByTimeAsync(20_000);
      expect(states.at(-1)).toBe('running');
      c!.stop();
    } finally { vi.useRealTimers(); }
  });
});
