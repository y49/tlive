// tests/daemon/lifecycle.test.ts
//
// Lifecycle shutdown order + reentrancy guard.

import { describe, it, expect, vi } from 'vitest';
import { createLifecycle, installSignalHandlers } from '../../src/daemon/lifecycle.js';

describe('createLifecycle', () => {
  it('runs steps in declared order', async () => {
    const order: string[] = [];
    const lc = createLifecycle([
      { name: 'a', async run() { order.push('a'); } },
      { name: 'b', async run() { order.push('b'); } },
      { name: 'c', async run() { order.push('c'); } },
    ]);
    await lc.shutdown();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('reentrant shutdown returns the same promise', async () => {
    let count = 0;
    const lc = createLifecycle([
      { name: 'once', async run() { count += 1; } },
    ]);
    const p1 = lc.shutdown();
    const p2 = lc.shutdown();
    await Promise.all([p1, p2]);
    expect(count).toBe(1);
  });

  it('swallows errors in any one step', async () => {
    const order: string[] = [];
    const lc = createLifecycle([
      { name: 'a', async run() { order.push('a'); } },
      { name: 'b', async run() { throw new Error('b fails'); } },
      { name: 'c', async run() { order.push('c'); } },
    ]);
    await lc.shutdown();
    expect(order).toEqual(['a', 'c']);
  });

  it('isShuttingDown flips before completion', async () => {
    const lc = createLifecycle([
      { name: 's', async run() {
        expect(lc.isShuttingDown()).toBe(true);
      } },
    ]);
    await lc.shutdown();
  });
});

describe('installSignalHandlers', () => {
  it('drives shutdown on signal and exits with 0', async () => {
    const lc = createLifecycle([
      { name: 'ok', async run() { /* no-op */ } },
    ]);
    const exits: number[] = [];
    let handler: (() => void) | null = null;
    installSignalHandlers({
      handle: lc,
      exit: (code) => exits.push(code),
      signals: ['SIGTERM'],
      bind: (_sig, fn) => { handler = fn; },
    });
    handler?.();
    // wait a tick for the async chain
    await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual([0]);
  });
});
