// src/kernel/daemon/__tests__/edit-queue.test.ts
//
// Task 10 review Important fix: per-requestId serial edit queue. Real edit()
// calls are network I/O — nothing guarantees "enqueued later → lands later".
// createEditQueue() must force strict FIFO landing order per rid, regardless
// of each fn's own latency, and must self-clean without dropping a link that
// was queued behind it.

import { describe, it, expect } from 'vitest';
import { createEditQueue } from '../edit-queue.js';

/** A deferred promise so a test can control exactly when a queued fn resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createEditQueue', () => {
  it('runs a single enqueued fn and resolves once it settles', async () => {
    const q = createEditQueue();
    let ran = false;
    await q.enqueue('r1', async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('serializes edits for the same rid in enqueue order, even when the FIRST one is slower', async () => {
    const q = createEditQueue();
    const order: string[] = [];
    const d1 = deferred<void>();

    // fn1 is enqueued first but doesn't resolve until we say so.
    const p1 = q.enqueue('r1', async () => { await d1.promise; order.push('fn1'); });
    // fn2 is enqueued second and would resolve "instantly" if run concurrently.
    const p2 = q.enqueue('r1', async () => { order.push('fn2'); });

    // Give fn2's own promise a chance to settle if (incorrectly) unserialized.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]); // fn2 must NOT have run yet — it's queued behind fn1

    d1.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['fn1', 'fn2']); // enqueue order, not intrinsic speed
  });

  it('different rids run independently (no cross-rid serialization)', async () => {
    const q = createEditQueue();
    const order: string[] = [];
    const dA = deferred<void>();

    const pA = q.enqueue('A', async () => { await dA.promise; order.push('A'); });
    const pB = q.enqueue('B', async () => { order.push('B'); }); // different rid — must not wait on A

    await pB;
    expect(order).toEqual(['B']); // B finished without waiting for A's deferred resolve

    dA.resolve();
    await pA;
    expect(order).toEqual(['B', 'A']);
  });

  it('a rejected fn does not break the chain — the next enqueued fn for the same rid still runs', async () => {
    const q = createEditQueue();
    const order: string[] = [];
    await q.enqueue('r1', async () => { order.push('fn1'); throw new Error('network fail'); });
    await q.enqueue('r1', async () => { order.push('fn2'); });
    expect(order).toEqual(['fn1', 'fn2']);
  });

  it('enqueue never rejects even when fn throws (same silent-catch tolerance as the old .catch(() => undefined))', async () => {
    const q = createEditQueue();
    await expect(q.enqueue('r1', async () => { throw new Error('boom'); })).resolves.toBeUndefined();
  });

  it('self-cleans: isActive(rid) goes false once the queue fully drains', async () => {
    const q = createEditQueue();
    expect(q.isActive('r1')).toBe(false);
    const p = q.enqueue('r1', async () => undefined);
    expect(q.isActive('r1')).toBe(true);
    await p;
    expect(q.isActive('r1')).toBe(false);
  });

  it('a fn that throws SYNCHRONOUSLY (not just returns a rejected promise) does not break the enqueue-never-rejects contract or leak the queue slot (hardening — unreachable via a real async IMAdapter.edit(), but fn is typed as a plain callback)', async () => {
    const q = createEditQueue();
    const syncThrow = (): Promise<unknown> => { throw new Error('sync boom'); };
    await expect(q.enqueue('r1', syncThrow)).resolves.toBeUndefined();
    expect(q.isActive('r1')).toBe(false);
    // The chain must still be usable afterward — a synchronous throw for one
    // rid must not wedge that rid's queue for subsequent enqueues.
    let ran = false;
    await q.enqueue('r1', async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('does not drop a newer link when an earlier one finishes and cleans up (no lost queued call)', async () => {
    const q = createEditQueue();
    const order: string[] = [];
    const d1 = deferred<void>();

    const p1 = q.enqueue('r1', async () => { await d1.promise; order.push('fn1'); });
    // fn2 is queued behind fn1 BEFORE fn1 resolves — its own settlement (and
    // fn1's cleanup racing against fn2 still being queued) is exactly the
    // "don't delete a link that's still in flight behind you" case.
    const d2 = deferred<void>();
    const p2 = q.enqueue('r1', async () => { await d2.promise; order.push('fn2'); });

    d1.resolve();
    await p1;
    // fn1 is done; fn2 must still be pending (not skipped, not run early) —
    // the queue for r1 must still be "active" because fn2 hasn't settled.
    expect(order).toEqual(['fn1']);
    expect(q.isActive('r1')).toBe(true);

    d2.resolve();
    await p2;
    expect(order).toEqual(['fn1', 'fn2']);
    expect(q.isActive('r1')).toBe(false);
  });
});
