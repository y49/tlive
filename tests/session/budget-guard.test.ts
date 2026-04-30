// tests/session/budget-guard.test.ts

import { describe, it, expect, vi } from 'vitest';
import { BudgetGuard, withinDailyCap } from '../../src/session/budget-guard.js';
import type { NotificationEvent } from '../../src/runtime/events.js';

describe('BudgetGuard.onEvent', () => {
  function makeGuard(opts: { cap?: number; total: number }) {
    let total = opts.total;
    const interrupt = vi.fn();
    const emit = vi.fn();
    const guard = new BudgetGuard(
      { getTotalCost: () => total, interrupt, emit },
      { maxBudgetUsd: opts.cap },
    );
    return { guard, interrupt, emit, setTotal: (n: number) => { total = n; } };
  }

  const turnEnd: NotificationEvent = {
    kind: 'turn_end', turnId: 't1', durationMs: 1, costUsd: 0.01, tokensIn: 1, tokensOut: 1,
  };

  it('fires interrupt + runtime_error when total ≥ cap', () => {
    const { guard, interrupt, emit, setTotal } = makeGuard({ cap: 0.10, total: 0.05 });
    setTotal(0.11);
    guard.onEvent(turnEnd);
    expect(interrupt).toHaveBeenCalled();
    expect(emit).toHaveBeenCalled();
    const event = emit.mock.calls[0][0] as NotificationEvent;
    expect(event.kind).toBe('runtime_error');
    if (event.kind === 'runtime_error') expect(event.code).toBe('budget_exceeded');
  });

  it('does not fire when total < cap', () => {
    const { guard, interrupt, emit } = makeGuard({ cap: 0.10, total: 0.05 });
    guard.onEvent(turnEnd);
    expect(interrupt).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('only fires once per trigger', () => {
    const { guard, interrupt, setTotal } = makeGuard({ cap: 0.10, total: 0.11 });
    setTotal(0.11);
    guard.onEvent(turnEnd);
    guard.onEvent(turnEnd);
    guard.onEvent(turnEnd);
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it('extend re-arms after override', () => {
    const { guard, interrupt, setTotal } = makeGuard({ cap: 0.10, total: 0.11 });
    guard.onEvent(turnEnd);
    expect(interrupt).toHaveBeenCalledTimes(1);
    guard.extend(0.50);
    setTotal(0.15);
    guard.onEvent(turnEnd);
    expect(interrupt).toHaveBeenCalledTimes(1); // still under new cap (0.6)
    setTotal(0.70);
    guard.onEvent(turnEnd);
    expect(interrupt).toHaveBeenCalledTimes(2);
  });

  it('no cap means disabled', () => {
    const { guard, interrupt } = makeGuard({ cap: undefined, total: 999 });
    guard.onEvent(turnEnd);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('non-turn_end events are ignored', () => {
    const { guard, interrupt } = makeGuard({ cap: 0.10, total: 0.99 });
    guard.onEvent({ kind: 'heartbeat', elapsedMs: 1 });
    expect(interrupt).not.toHaveBeenCalled();
  });
});

describe('BudgetGuard.setCap', () => {
  function makeGuard(opts: { cap?: number; total: number }) {
    let total = opts.total;
    const interrupt = vi.fn();
    const emit = vi.fn();
    const guard = new BudgetGuard(
      { getTotalCost: () => total, interrupt, emit },
      { maxBudgetUsd: opts.cap },
    );
    return { guard, interrupt, emit, setTotal: (n: number) => { total = n; } };
  }

  it('updates max cap to new value', () => {
    const { guard } = makeGuard({ cap: 5, total: 0 });
    guard.setCap(20);
    expect(guard.cap).toBe(20);
  });

  it('clears cap when set to undefined', () => {
    const { guard } = makeGuard({ cap: 5, total: 0 });
    guard.setCap(undefined);
    expect(guard.cap).toBeUndefined();
  });

  it('sets cap from undefined to a value', () => {
    const { guard } = makeGuard({ cap: undefined, total: 100 });
    guard.setCap(50);
    expect(guard.cap).toBe(50);
  });
});

describe('withinDailyCap', () => {
  it('ok=true when cap is undefined', () => {
    expect(withinDailyCap(100, undefined).ok).toBe(true);
  });
  it('ok=true with remaining when under cap', () => {
    const r = withinDailyCap(3, 10);
    expect(r.ok).toBe(true);
    expect(r.remainingUsd).toBe(7);
  });
  it('ok=false when already at cap', () => {
    const r = withinDailyCap(10, 10);
    expect(r.ok).toBe(false);
    expect(r.remainingUsd).toBe(0);
  });
});
