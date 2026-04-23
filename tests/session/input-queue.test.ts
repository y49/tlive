// tests/session/input-queue.test.ts

import { describe, it, expect } from 'vitest';
import { InputQueue, InputQueueFullError } from '../../src/session/input-queue.js';

describe('InputQueue', () => {
  it('enqueue increments size', () => {
    const q = new InputQueue();
    q.enqueue('a');
    q.enqueue('b');
    expect(q.size()).toBe(2);
  });

  it('dequeue returns FIFO order and shrinks size', () => {
    const q = new InputQueue();
    q.enqueue('first');
    q.enqueue('second');
    expect(q.dequeue()?.text).toBe('first');
    expect(q.dequeue()?.text).toBe('second');
    expect(q.size()).toBe(0);
  });

  it('cancel by id removes the matching item', () => {
    const q = new InputQueue();
    const a = q.enqueue('a');
    q.enqueue('b');
    expect(q.cancel(a.id)).toBe(true);
    expect(q.size()).toBe(1);
    expect(q.cancel('nope')).toBe(false);
  });

  it('cancelByIndex removes by position', () => {
    const q = new InputQueue();
    q.enqueue('a');
    q.enqueue('b');
    const removed = q.cancelByIndex(0);
    expect(removed?.text).toBe('a');
    expect(q.snapshot().map((i) => i.text)).toEqual(['b']);
    expect(q.cancelByIndex(99)).toBeNull();
  });

  it('throws InputQueueFullError beyond maxSize', () => {
    const q = new InputQueue(2);
    q.enqueue('a');
    q.enqueue('b');
    expect(() => q.enqueue('c')).toThrow(InputQueueFullError);
  });

  it('subscribe fires on enqueue/dequeue/cancel', () => {
    const q = new InputQueue();
    const events: string[] = [];
    q.subscribe((ev) => events.push(ev.kind));
    const a = q.enqueue('a');
    q.dequeue();
    q.enqueue('b');
    q.cancel(q.snapshot()[0].id);
    expect(events).toEqual(['enqueued', 'dequeued', 'enqueued', 'cancelled']);
    expect(a.id).toBeTruthy();
  });

  it('snapshot returns a copy (mutations do not leak)', () => {
    const q = new InputQueue();
    q.enqueue('a');
    const snap = q.snapshot();
    snap.length = 0;
    expect(q.size()).toBe(1);
  });
});
