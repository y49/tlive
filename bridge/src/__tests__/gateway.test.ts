import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PendingPermissions } from '../permissions/gateway.js';

describe('PendingPermissions', () => {
  let gateway: PendingPermissions;

  beforeEach(() => {
    gateway = new PendingPermissions();
  });

  it('waitFor returns a promise that resolves on allow', async () => {
    const promise = gateway.waitFor('tool1');
    gateway.resolve('tool1', 'allow');
    const result = await promise;
    expect(result.behavior).toBe('allow');
  });

  it('waitFor returns deny result on deny', async () => {
    const promise = gateway.waitFor('tool2');
    gateway.resolve('tool2', 'deny');
    const result = await promise;
    expect(result.behavior).toBe('deny');
  });

  it('resolve returns true if permission was pending', () => {
    gateway.waitFor('tool1');
    expect(gateway.resolve('tool1', 'allow')).toBe(true);
  });

  it('resolve returns false if no pending permission', () => {
    expect(gateway.resolve('unknown', 'allow')).toBe(false);
  });

  it('waitFor creates a pending entry', async () => {
    // Just verify the waitFor call creates a pending entry
    gateway.waitFor('tool1');
    expect(gateway.pendingCount()).toBe(1);
    // Clean up
    gateway.denyAll();
  });

  it('denyAll denies all pending permissions', async () => {
    const p1 = gateway.waitFor('t1');
    const p2 = gateway.waitFor('t2');
    gateway.denyAll();
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.behavior).toBe('deny');
    expect(r2.behavior).toBe('deny');
  });

  it('pendingCount returns number of pending', () => {
    gateway.waitFor('t1');
    gateway.waitFor('t2');
    expect(gateway.pendingCount()).toBe(2);
    gateway.resolve('t1', 'allow');
    expect(gateway.pendingCount()).toBe(1);
  });

  describe('timeout callback', () => {
    it('invokes onTimeout before resolving with deny', async () => {
      vi.useFakeTimers();
      const gw = new PendingPermissions();
      const onTimeout = vi.fn();

      const promise = gw.waitFor('tool-1', { onTimeout, timeoutMs: 1000 });
      vi.advanceTimersByTime(1001);

      const result = await promise;
      expect(result.behavior).toBe('deny');
      expect(onTimeout).toHaveBeenCalledWith('tool-1');

      vi.useRealTimers();
    });

    it('does not timeout when default (0) is used — waits indefinitely', async () => {
      vi.useFakeTimers();
      const gw = new PendingPermissions();

      let resolved = false;
      const promise = gw.waitFor('tool-2').then((r) => { resolved = true; return r; });

      // Advance well past the old 5-minute default — should NOT resolve
      vi.advanceTimersByTime(10 * 60 * 1000);
      await Promise.resolve(); // flush microtasks
      expect(resolved).toBe(false);
      expect(gw.isPending('tool-2')).toBe(true);

      // Clean up by resolving manually
      gw.resolve('tool-2', 'allow');
      const result = await promise;
      expect(result.behavior).toBe('allow');

      vi.useRealTimers();
    });
  });
});
