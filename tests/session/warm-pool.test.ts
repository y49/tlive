// tests/session/warm-pool.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WarmRuntimePool } from '../../src/session/warm-pool.js';
import { FakeRuntime } from './fake-runtime.js';

describe('WarmRuntimePool', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('park then pluck returns same runtime', () => {
    const pool = new WarmRuntimePool({ ttlSec: 60, max: 2 });
    const r = new FakeRuntime('claude');
    pool.park(r, 'ws-1');
    const plucked = pool.pluck('claude', 'ws-1');
    expect(plucked).toBe(r);
    expect(pool.size()).toBe(0);
  });

  it('pluck returns null when no match', () => {
    const pool = new WarmRuntimePool();
    const r = new FakeRuntime('claude');
    pool.park(r, 'ws-1');
    expect(pool.pluck('codex', 'ws-1')).toBeNull();
    expect(pool.pluck('claude', 'ws-2')).toBeNull();
  });

  it('TTL evicts stale entries and calls runtime.stop', async () => {
    const pool = new WarmRuntimePool({ ttlSec: 1, max: 3 });
    const r = new FakeRuntime('claude');
    pool.park(r, 'ws-1');
    expect(pool.size()).toBe(1);
    vi.advanceTimersByTime(1500);
    // Allow pending microtasks scheduled by evict()'s stop() promise to settle.
    await Promise.resolve();
    expect(pool.size()).toBe(0);
    expect(r.stopCalls).toBe(1);
  });

  it('park over capacity evicts oldest', async () => {
    const pool = new WarmRuntimePool({ ttlSec: 60, max: 2 });
    const a = new FakeRuntime('claude');
    const b = new FakeRuntime('claude');
    const c = new FakeRuntime('claude');
    pool.park(a, 'ws-1');
    pool.park(b, 'ws-2');
    pool.park(c, 'ws-3');
    expect(pool.size()).toBe(2);
    // 'a' should have been evicted + stopped
    expect(a.stopCalls).toBe(1);
  });

  it('drain stops every parked runtime', async () => {
    const pool = new WarmRuntimePool();
    const a = new FakeRuntime('claude');
    const b = new FakeRuntime('codex');
    pool.park(a, 'ws-1');
    pool.park(b, 'ws-2');
    await pool.drain();
    expect(a.stopCalls).toBe(1);
    expect(b.stopCalls).toBe(1);
    expect(pool.size()).toBe(0);
  });
});
