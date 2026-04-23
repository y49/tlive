// src/mcp/self/signals.ts
//
// SignalBus implementation powering `tlive.await_signal` + long-poll tools.
// Tests can use this directly; production wires it into the daemon so IM
// /interrupt and /send commands emit here.

import type { SignalBus } from './deps.js';

interface Waiter {
  kind: 'interrupt' | 'user_input' | 'any';
  resolve: (v: { kind: string; payload?: unknown } | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class InMemorySignalBus implements SignalBus {
  private waiters = new Map<string, Set<Waiter>>();

  await(
    sessionId: string,
    kind: 'interrupt' | 'user_input' | 'any',
    timeoutMs: number,
  ): Promise<{ kind: string; payload?: unknown } | null> {
    return new Promise((resolve) => {
      const set = this.waiters.get(sessionId) ?? new Set<Waiter>();
      this.waiters.set(sessionId, set);
      const timer = setTimeout(() => {
        set.delete(waiter);
        resolve(null);
      }, Math.max(1, timeoutMs));
      const waiter: Waiter = { kind, resolve, timer };
      set.add(waiter);
    });
  }

  emit(sessionId: string, kind: 'interrupt' | 'user_input', payload?: unknown): void {
    const set = this.waiters.get(sessionId);
    if (!set) return;
    for (const w of [...set]) {
      if (w.kind === 'any' || w.kind === kind) {
        clearTimeout(w.timer);
        set.delete(w);
        try { w.resolve({ kind, payload }); } catch { /* isolate */ }
      }
    }
    if (set.size === 0) this.waiters.delete(sessionId);
  }

  /** Cancel all waiters for a session (disconnect). */
  cancel(sessionId: string): void {
    const set = this.waiters.get(sessionId);
    if (!set) return;
    for (const w of set) {
      clearTimeout(w.timer);
      try { w.resolve(null); } catch { /* isolate */ }
    }
    this.waiters.delete(sessionId);
  }
}
