// src/im/reply-document/scheduler.ts
//
// ReplyScheduler — debounces flush events into a single edit per 250ms,
// emits silence ticks every 1.5s (3s when ask-blocked) up to a cap of 20,
// resetting the silence counter on real events. Pure timer logic; the flush
// thunk is injected so this layer doesn't know about adapters.

import { TICK, type Priority } from './edit-queue.js';

function minPrio(a: Priority, b: Priority): Priority {
  return (a < b ? a : b) as Priority;
}

export class ReplyScheduler {
  private debounceTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private silenceTickCount = 0;
  // Default to the lowest priority (TICK = numerically highest) so the first
  // schedule call wins via minPrio. Reset to TICK after each flush so the
  // next batch starts neutral too.
  private pendingPrio: Priority = TICK;
  private askBlocked = false;
  private stopped = false;

  static DEBOUNCE_MS = 250;
  static SILENCE_TICK_MS = 1500;
  static ASK_BLOCKED_TICK_MS = 3000;
  static SILENCE_TICK_CAP = 20;

  constructor(private readonly flush: (prio: Priority) => Promise<void>) {}

  schedule(reason: 'event' | 'tick', prio: Priority): void {
    if (this.stopped) return;
    this.pendingPrio = minPrio(this.pendingPrio, prio);
    // A real event resets the silence streak (per spec § 5.4): silenceTickCount
    // returns to 0 so a fresh 30s burst of ticks can fire after activity. A
    // silence tick itself does NOT reset the count — that's how we approach
    // the cap and eventually quiesce. The silence streak timer is rearmed via
    // armSilenceTick() at the end of the debounced flush.
    if (reason === 'event') {
      this.silenceTickCount = 0;
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
    }
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      const p = this.pendingPrio;
      this.pendingPrio = TICK;
      await this.flush(p);
      this.armSilenceTick();
    }, ReplyScheduler.DEBOUNCE_MS);
  }

  setAskBlocked(b: boolean): void {
    if (this.askBlocked === b) return;
    this.askBlocked = b;
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    this.armSilenceTick();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
  }

  private armSilenceTick(): void {
    if (this.stopped) return;
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.silenceTickCount >= ReplyScheduler.SILENCE_TICK_CAP) return;
    const interval = this.askBlocked
      ? ReplyScheduler.ASK_BLOCKED_TICK_MS
      : ReplyScheduler.SILENCE_TICK_MS;
    this.silenceTimer = setTimeout(() => {
      this.silenceTickCount++;
      this.schedule('tick', TICK);
    }, interval);
  }
}
