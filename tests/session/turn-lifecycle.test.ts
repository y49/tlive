// tests/session/turn-lifecycle.test.ts

import { describe, it, expect } from 'vitest';
import { TurnLifecycle } from '../../src/session/turn-lifecycle.js';

describe('TurnLifecycle', () => {
  it('tracks currentTurnId across turn_start / turn_end', () => {
    const tl = new TurnLifecycle();
    expect(tl.currentTurnId()).toBeNull();
    tl.onEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: 'hi', at: Date.now() });
    expect(tl.currentTurnId()).toBe('t1');
    tl.onEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 10, costUsd: 0, tokensIn: 0, tokensOut: 0,
    });
    expect(tl.currentTurnId()).toBeNull();
  });

  it('durationMs reports 0 before a turn_start', () => {
    const tl = new TurnLifecycle();
    expect(tl.durationMs()).toBe(0);
  });

  it('durationMs grows monotonically between turn_start and turn_end', async () => {
    const tl = new TurnLifecycle();
    tl.onEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: '', at: Date.now() });
    // Allow the clock to advance at least 1ms.
    await new Promise((r) => setTimeout(r, 5));
    expect(tl.durationMs()).toBeGreaterThanOrEqual(1);
    tl.onEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 0, costUsd: 0, tokensIn: 0, tokensOut: 0,
    });
    expect(tl.durationMs()).toBe(0);
  });

  it('ignores non-turn events', () => {
    const tl = new TurnLifecycle();
    const out = tl.onEvent({ kind: 'heartbeat', elapsedMs: 5 });
    expect(out).toEqual([]);
    expect(tl.currentTurnId()).toBeNull();
  });
});
