// src/im/reply-document/edit-queue.ts
//
// Priority + token-bucket queue for IM message edits.
// Three priority levels (CRITICAL=0, NORMAL=1, TICK=2):
//   - CRITICAL never dropped — turn_start/freeze/error/Ask/Permission state
//   - NORMAL coalesces by msgId, fires when tokens available
//   - TICK dropped silently when retryAfter active or under 429 backpressure
//
// Coalescing: enqueue(chatId, msgId, fire, prio) replaces the pending edit
// for the same msgId with the latest fire fn — render output is always
// derived from current state, so the latest fire is canonical.
//
// 429 handling: on RateLimitError, set retryAfterUntil + jitter, requeue
// failed edit at CRITICAL prio (TICK dropped), purge all TICK pending.
// Three consecutive 429s within 5s → 60s circuit-break, log error.

import { RateLimitError } from '../../platform/types.js';
import type { Logger } from '../../util/logger.js';

export const CRITICAL = 0 as const;
export const NORMAL = 1 as const;
export const TICK = 2 as const;
export type Priority = typeof CRITICAL | typeof NORMAL | typeof TICK;

export interface EditQueueOptions {
  refillMs: number;
  capacity: number;
  jitterMs?: number;
  consecutive429Limit?: number;
  circuitBreakMs?: number;
}

interface PendingEdit {
  msgId: string;
  prio: Priority;
  fire: () => Promise<void>;
  enqueuedAt: number;
}

interface ChatBucket {
  chatId: string;
  tokens: number;
  capacity: number;
  refillMs: number;
  refillTimer: NodeJS.Timeout | null;
  retryAfterUntil: number;
  consecutive429: number;
  consecutive429StartedAt: number;
  circuitBreakUntil: number;
  pending: Map<string, PendingEdit>;
  drainTimer: NodeJS.Timeout | null;
  draining: boolean;
}

export class EditQueue {
  private readonly buckets = new Map<string, ChatBucket>();
  private readonly opts: Required<EditQueueOptions>;

  constructor(opts: EditQueueOptions, private readonly log?: Logger) {
    this.opts = {
      refillMs: opts.refillMs,
      capacity: opts.capacity,
      jitterMs: opts.jitterMs ?? 250,
      consecutive429Limit: opts.consecutive429Limit ?? 3,
      circuitBreakMs: opts.circuitBreakMs ?? 60_000,
    };
  }

  enqueue(chatId: string, msgId: string, fire: () => Promise<void>, prio: Priority): void {
    const b = this.bucket(chatId);
    const now = Date.now();
    if (now < b.circuitBreakUntil) {
      this.log?.warn?.('editQueue.circuit-break.drop', { chatId, msgId, prio });
      return;
    }
    if (now < b.retryAfterUntil && prio === TICK) {
      this.log?.debug?.('editQueue.drop', { chatId, msgId, reason: '429-tick-drop' });
      return;
    }
    const existing = b.pending.get(msgId);
    if (existing) {
      existing.fire = fire;
      existing.prio = (Math.min(existing.prio, prio) as Priority);
    } else {
      b.pending.set(msgId, { msgId, prio, fire, enqueuedAt: now });
    }
    this.scheduleDrain(b);
  }

  private bucket(chatId: string): ChatBucket {
    let b = this.buckets.get(chatId);
    if (b) return b;
    b = {
      chatId, tokens: this.opts.capacity, capacity: this.opts.capacity,
      refillMs: this.opts.refillMs, refillTimer: null,
      retryAfterUntil: 0, consecutive429: 0, consecutive429StartedAt: 0,
      circuitBreakUntil: 0, pending: new Map(), drainTimer: null, draining: false,
    };
    this.buckets.set(chatId, b);
    return b;
  }

  private scheduleDrain(b: ChatBucket, delayMs = 0): void {
    // Always allow scheduling — drain itself is re-entrancy guarded. If a
    // drain is currently in progress and we schedule another, the second
    // drain runs after the first completes (the timer fires, drain checks
    // its own draining flag if needed, but normally drain has already
    // returned before the timer fires when there's a non-zero delay).
    if (b.drainTimer) return;
    b.drainTimer = setTimeout(() => {
      b.drainTimer = null;
      void this.drain(b);
    }, delayMs);
  }

  private async drain(b: ChatBucket): Promise<void> {
    if (b.draining) return;
    b.draining = true;
    try {
      const now = Date.now();
      if (now < b.circuitBreakUntil) {
        this.scheduleDrain(b, b.circuitBreakUntil - now);
        return;
      }
      if (now < b.retryAfterUntil) {
        this.scheduleDrain(b, b.retryAfterUntil - now);
        return;
      }
      while (b.pending.size > 0 && b.tokens >= 1) {
        const next = pickByPriorityThenOldest(b.pending);
        b.pending.delete(next.msgId);
        b.tokens--;
        try {
          await next.fire();
          b.consecutive429 = 0;
          b.consecutive429StartedAt = 0;
        } catch (err) {
          if (err instanceof RateLimitError) {
            b.consecutive429++;
            if (b.consecutive429 === 1) b.consecutive429StartedAt = Date.now();
            const elapsed = Date.now() - b.consecutive429StartedAt;
            if (b.consecutive429 >= this.opts.consecutive429Limit && elapsed <= 5000) {
              b.circuitBreakUntil = Date.now() + this.opts.circuitBreakMs;
              this.log?.error?.('editQueue.circuit-break', {
                chatId: b.chatId, count: b.consecutive429, elapsedMs: elapsed,
              });
              this.dropAllTicks(b);
              // Re-queue the failed CRITICAL edit so it fires post-circuit.
              if (next.prio < TICK) {
                b.pending.set(next.msgId, { ...next, prio: CRITICAL });
              }
              this.scheduleDrain(b, b.circuitBreakUntil - Date.now());
              return;
            }
            const retryAfter = err.retryAfterMs * Math.min(b.consecutive429, 3);
            b.retryAfterUntil = Date.now() + retryAfter + this.opts.jitterMs;
            this.log?.warn?.('editQueue.429', {
              chatId: b.chatId, msgId: next.msgId, retryAfterMs: retryAfter,
            });
            if (next.prio < TICK) {
              b.pending.set(next.msgId, { ...next, prio: CRITICAL });
            }
            this.dropAllTicks(b);
            this.scheduleDrain(b, b.retryAfterUntil - Date.now());
            this.startRefill(b);
            return;
          }
          this.log?.warn?.('editQueue.error', {
            chatId: b.chatId, msgId: next.msgId, err: (err as Error).message,
          });
        }
      }
      this.startRefill(b);
    } finally {
      b.draining = false;
    }
  }

  private dropAllTicks(b: ChatBucket): void {
    for (const [k, v] of b.pending) {
      if (v.prio === TICK) b.pending.delete(k);
    }
  }

  private startRefill(b: ChatBucket): void {
    if (b.refillTimer) return;
    b.refillTimer = setInterval(() => {
      if (b.tokens < b.capacity) b.tokens++;
      if (b.pending.size > 0 && Date.now() >= b.retryAfterUntil && Date.now() >= b.circuitBreakUntil) {
        // Drain inline rather than via setTimeout(0) — the latter races
        // with vi.advanceTimersByTimeAsync at exact boundary timestamps,
        // and there's no benefit to deferring (we're already in a timer
        // callback so the call stack is empty enough).
        void this.drain(b);
      }
      if (b.tokens >= b.capacity && b.pending.size === 0) {
        clearInterval(b.refillTimer!);
        b.refillTimer = null;
      }
    }, b.refillMs);
  }
}

function pickByPriorityThenOldest(pending: Map<string, PendingEdit>): PendingEdit {
  let best: PendingEdit | undefined;
  for (const e of pending.values()) {
    if (!best) { best = e; continue; }
    if (e.prio < best.prio) { best = e; continue; }
    if (e.prio === best.prio && e.enqueuedAt < best.enqueuedAt) { best = e; }
  }
  return best!;
}
