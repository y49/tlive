import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditQueue, CRITICAL, NORMAL, TICK } from '../../../src/im/reply-document/edit-queue.js';
import { RateLimitError } from '../../../src/platform/types.js';

const TG_OPTS = { refillMs: 2000, capacity: 5 };

describe('EditQueue — coalesce within msgId', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('replaces fire fn for same msgId, priority 取高(数小)', async () => {
    const calls: string[] = [];
    const q = new EditQueue(TG_OPTS);
    q.enqueue('chat1', 'msg1', async () => { calls.push('first'); }, NORMAL);
    q.enqueue('chat1', 'msg1', async () => { calls.push('second'); }, CRITICAL);
    await vi.runAllTimersAsync();
    expect(calls).toEqual(['second']);
  });

  it('TICK 在 retryAfter 期内被丢', async () => {
    const q = new EditQueue(TG_OPTS);
    const fired: string[] = [];
    q.enqueue('chat1', 'msg1', async () => {
      fired.push('first-429');
      throw new RateLimitError(1000, 'telegram', '429');
    }, NORMAL);
    await vi.runOnlyPendingTimersAsync();
    q.enqueue('chat1', 'msg2', async () => { fired.push('tick-should-not-fire'); }, TICK);
    await vi.advanceTimersByTimeAsync(500);
    expect(fired).not.toContain('tick-should-not-fire');
  });
});

describe('EditQueue — token bucket 限速', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('burst 5 后阻塞,refill 后恢复', async () => {
    const q = new EditQueue({ refillMs: 2000, capacity: 5 });
    const fired: number[] = [];
    for (let i = 0; i < 7; i++) {
      q.enqueue('chat1', `msg${i}`, async () => { fired.push(i); }, NORMAL);
    }
    await vi.runOnlyPendingTimersAsync();
    expect(fired.length).toBe(5);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fired.length).toBeGreaterThanOrEqual(6);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fired.length).toBe(7);
  });

  it('跨 chatId 独立 bucket', async () => {
    const q = new EditQueue({ refillMs: 2000, capacity: 5 });
    const fired = new Set<string>();
    for (let i = 0; i < 5; i++) {
      q.enqueue('chatA', `msg${i}`, async () => { fired.add(`A-${i}`); }, NORMAL);
      q.enqueue('chatB', `msg${i}`, async () => { fired.add(`B-${i}`); }, NORMAL);
    }
    await vi.runOnlyPendingTimersAsync();
    expect(fired.size).toBe(10);
  });
});

describe('EditQueue — 429 retry-after', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('CRITICAL 在 retryAfter 后重试', async () => {
    const q = new EditQueue({ refillMs: 2000, capacity: 5 });
    const fired: string[] = [];
    let firstCall = true;
    q.enqueue('chat1', 'msg1', async () => {
      if (firstCall) { firstCall = false; throw new RateLimitError(1000, 'telegram', '429'); }
      fired.push('success');
    }, CRITICAL);
    await vi.runOnlyPendingTimersAsync();
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fired).toEqual(['success']);
  });

  it('熔断:连续 3 次 429 后 chatId stop drain ~60s', async () => {
    const q = new EditQueue({ refillMs: 2000, capacity: 5 });
    const fired: string[] = [];
    q.enqueue('chat1', 'msg1', async () => {
      fired.push('attempt');
      throw new RateLimitError(500, 'telegram', '429');
    }, CRITICAL);
    // Drive through 3+ retry cycles to trigger circuit
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1500);
    }
    const beforeCircuit = fired.length;
    expect(beforeCircuit).toBeGreaterThanOrEqual(3);  // at least 3 attempts before circuit
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fired.length).toBe(beforeCircuit);  // suppressed during circuit
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fired.length).toBeGreaterThan(beforeCircuit);  // post-circuit recovery
  });
});
