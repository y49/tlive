import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ensureCodexAppServer, codexAppServerSockPath } from '../spawn.js';

const fakeChild = () => Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn() });

describe('ensureCodexAppServer', () => {
  it('adopts an already-listening socket without spawning', async () => {
    const spawnFn = vi.fn();
    const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => true, spawnFn: spawnFn as any, platform: 'linux', hasCodex: () => true });
    expect(c).toMatchObject({ adopted: true });
    expect(spawnFn).not.toHaveBeenCalled();
    c!.stop(); // no-op, must not throw
  });
  it('spawns when socket absent and respawns on exit', async () => {
    vi.useFakeTimers();
    try {
      const children: any[] = [];
      const spawnFn = vi.fn(() => { const ch = fakeChild(); children.push(ch); return ch; });
      const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => false, spawnFn: spawnFn as any, platform: 'linux', hasCodex: () => true });
      expect(c).toMatchObject({ adopted: false });
      expect(spawnFn).toHaveBeenCalledTimes(1);
      children[0].emit('exit', 1);
      await vi.advanceTimersByTimeAsync(1100);
      expect(spawnFn).toHaveBeenCalledTimes(2);
      c!.stop();
      expect(children[1].kill).toHaveBeenCalled();
      children[1].emit('exit', 0); // stop() 后退出不得重拉
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawnFn).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('gives up after 6 straight fast exits and reports degraded', async () => {
    vi.useFakeTimers();
    try {
      const states: string[] = [];
      const spawnFn = vi.fn(() => { const ch = fakeChild(); setTimeout(() => ch.emit('exit', 1), 10); return ch; });
      await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => false, spawnFn: spawnFn as any, onStateChange: (s) => states.push(s), platform: 'linux', hasCodex: () => true });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(spawnFn.mock.calls.length).toBeLessThanOrEqual(7);
      expect(states.at(-1)).toBe('degraded');
    } finally { vi.useRealTimers(); }
  });
  it('respawns after backoff when a child emits error with no exit', async () => {
    vi.useFakeTimers();
    try {
      const children: any[] = [];
      const spawnFn = vi.fn(() => { const ch = fakeChild(); children.push(ch); return ch; });
      const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => false, spawnFn: spawnFn as any, platform: 'linux', hasCodex: () => true });
      expect(spawnFn).toHaveBeenCalledTimes(1);
      children[0].emit('error', new Error('EACCES'));
      await vi.advanceTimersByTimeAsync(1100);
      expect(spawnFn).toHaveBeenCalledTimes(2);
      c!.stop();
    } finally { vi.useRealTimers(); }
  });
  it('counts a child emitting error then exit only once (no double respawn)', async () => {
    vi.useFakeTimers();
    try {
      const children: any[] = [];
      const spawnFn = vi.fn(() => { const ch = fakeChild(); children.push(ch); return ch; });
      const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => false, spawnFn: spawnFn as any, platform: 'linux', hasCodex: () => true });
      children[0].emit('error', new Error('EACCES'));
      children[0].emit('exit', 1);
      await vi.advanceTimersByTimeAsync(1100);
      expect(spawnFn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(spawnFn).toHaveBeenCalledTimes(2);
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
    expect(codexAppServerSockPath('/ch')).toBe('/ch/app-server-control/app-server-control.sock');
  });
  it('returns null on win32', async () => {
    const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => true, platform: 'win32', hasCodex: () => true });
    expect(c).toBeNull();
  });
  it('returns null when codex missing from PATH', async () => {
    const c = await ensureCodexAppServer({ logPath: '/tmp/x.log', probe: async () => true, platform: 'linux', hasCodex: () => false });
    expect(c).toBeNull();
  });
});
