// src/session/input-queue.ts
//
// Per-session observable input queue. Wraps calls to `runtime.sendInput` so
// IM users can keep typing while a turn is in flight — inputs are replayed
// onto the runtime when the current turn completes. LocalSession consults
// `size()` to advertise `queuedInputs` via AgentStatus so renderers can
// badge the session header.

import { randomBytes } from 'node:crypto';
import type { SendInputOptions } from '../runtime/types.js';

export interface QueuedInput {
  id: string;
  text: string;
  opts?: SendInputOptions;
  queuedAt: number;
  userId?: string;
}

export class InputQueueFullError extends Error {
  constructor(maxSize: number) {
    super(`input queue full (${maxSize}); wait for current turn to complete`);
    this.name = 'InputQueueFullError';
  }
}

export type InputQueueListener = (ev:
  | { kind: 'enqueued'; item: QueuedInput; size: number }
  | { kind: 'dequeued'; item: QueuedInput; size: number }
  | { kind: 'cancelled'; id: string; size: number }
) => void;

export class InputQueue {
  private items: QueuedInput[] = [];
  private readonly maxSize: number;
  private readonly listeners = new Set<InputQueueListener>();

  constructor(maxSize = 10) { this.maxSize = maxSize; }

  enqueue(text: string, opts?: SendInputOptions, userId?: string): QueuedInput {
    if (this.items.length >= this.maxSize) throw new InputQueueFullError(this.maxSize);
    const item: QueuedInput = {
      id: randomBytes(3).toString('hex'),
      text,
      opts,
      queuedAt: Date.now(),
      userId,
    };
    this.items.push(item);
    this.emit({ kind: 'enqueued', item, size: this.items.length });
    return item;
  }

  dequeue(): QueuedInput | undefined {
    const item = this.items.shift();
    if (item) this.emit({ kind: 'dequeued', item, size: this.items.length });
    return item;
  }

  cancel(id: string): boolean {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    this.emit({ kind: 'cancelled', id, size: this.items.length });
    return true;
  }

  /** Cancel by 0-based position (/cancel-queued N command). */
  cancelByIndex(i: number): QueuedInput | null {
    if (i < 0 || i >= this.items.length) return null;
    const [removed] = this.items.splice(i, 1);
    this.emit({ kind: 'cancelled', id: removed.id, size: this.items.length });
    return removed;
  }

  clear(): void {
    while (this.items.length > 0) {
      const [item] = this.items.splice(0, 1);
      this.emit({ kind: 'cancelled', id: item.id, size: this.items.length });
    }
  }

  snapshot(): QueuedInput[] { return [...this.items]; }
  size(): number { return this.items.length; }

  subscribe(cb: InputQueueListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(ev: Parameters<InputQueueListener>[0]): void {
    for (const l of this.listeners) { try { l(ev); } catch { /* isolate */ } }
  }
}
