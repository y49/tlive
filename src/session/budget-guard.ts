// src/session/budget-guard.ts
//
// Per-session + per-workspace cost cap enforcement. Wired into LocalSession's
// event stream: on every `turn_end`, we compare the running totalCost to the
// cap and, when exceeded, fire `session.interrupt()` and emit a synthesized
// `runtime_error` with `code: 'budget_exceeded'` so the IM renderer can show
// an `[Override +$0.50]` button. SessionManager additionally pre-checks the
// workspace's daily aggregate before creating new sessions.

import type { NotificationEvent } from '../runtime/events.js';

export interface BudgetGuardDeps {
  /** Live total USD cost of the session. */
  getTotalCost: () => number;
  /** Force the session to interrupt (reject pending + runtime.interrupt). */
  interrupt: () => Promise<void> | void;
  /** Emit a synthesized NotificationEvent onto the session event stream. */
  emit: (e: NotificationEvent) => void;
}

export interface BudgetGuardOptions {
  /** Per-session cap in USD. undefined disables the guard. */
  maxBudgetUsd?: number;
  /** Retry hint emitted alongside `budget_exceeded` (default 0 — no retry). */
  retryHintMs?: number;
}

export class BudgetGuard {
  private triggered = false;

  constructor(
    private readonly deps: BudgetGuardDeps,
    private options: BudgetGuardOptions,
  ) {}

  /** Feed a NotificationEvent; no-op for non-`turn_end` kinds. */
  onEvent(ev: NotificationEvent): void {
    if (ev.kind !== 'turn_end') return;
    if (this.options.maxBudgetUsd === undefined) return;
    if (this.triggered) return;
    const total = this.deps.getTotalCost();
    if (total < this.options.maxBudgetUsd) return;
    this.triggered = true;
    // Interrupt is async but we don't block event dispatch; errors are
    // surfaced via the subsequent runtime_error event anyway.
    void Promise.resolve(this.deps.interrupt()).catch(() => undefined);
    this.deps.emit({
      kind: 'runtime_error',
      severity: 'warn',
      code: 'budget_exceeded',
      message: `session budget exceeded: $${total.toFixed(4)} > $${this.options.maxBudgetUsd.toFixed(2)}`,
      retryHintMs: this.options.retryHintMs,
    });
  }

  /** Extend the cap (IM "Override +$X" button). Re-arms the guard. */
  extend(extraUsd: number): void {
    if (this.options.maxBudgetUsd === undefined) {
      this.options = { ...this.options, maxBudgetUsd: extraUsd };
    } else {
      this.options = { ...this.options, maxBudgetUsd: this.options.maxBudgetUsd + extraUsd };
    }
    this.triggered = false;
  }

  /** Replace the cap outright (used by /budget command). undefined disables the
   *  guard. Re-arms so a newly-raised cap can fire again on the next turn_end. */
  setCap(usd: number | undefined): void {
    this.options = { ...this.options, maxBudgetUsd: usd };
    this.triggered = false;
  }

  reset(): void { this.triggered = false; }

  get cap(): number | undefined { return this.options.maxBudgetUsd; }
  get hasTriggered(): boolean { return this.triggered; }
}

/**
 * Workspace-level daily cap check — returns true if a new session may be
 * created, false if the aggregate has already met or exceeded the cap.
 * `SessionManager.createLocal` calls this before constructing a LocalSession.
 */
export function withinDailyCap(
  currentDailyTotalUsd: number,
  dailyCapUsd: number | undefined,
): { ok: boolean; remainingUsd: number } {
  if (dailyCapUsd === undefined) return { ok: true, remainingUsd: Infinity };
  const remaining = dailyCapUsd - currentDailyTotalUsd;
  return { ok: remaining > 0, remainingUsd: Math.max(0, remaining) };
}
