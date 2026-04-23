// tests/cost/tracker.test.ts

import { describe, it, expect } from 'vitest';
import { CostTracker } from '../../src/cost/tracker.js';

describe('CostTracker', () => {
  it('initializes to zero', () => {
    const t = new CostTracker();
    expect(t.totalCost).toBe(0);
    expect(t.inputTokens).toBe(0);
    expect(t.outputTokens).toBe(0);
    expect(t.cacheReadTokens).toBe(0);
    expect(t.cacheCreationTokens).toBe(0);
  });

  it('add() folds running totals', () => {
    const t = new CostTracker();
    t.add({ inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    t.add({ inputTokens: 200, outputTokens: 75, costUsd: 0.02 });
    expect(t.inputTokens).toBe(300);
    expect(t.outputTokens).toBe(125);
    expect(t.totalCost).toBeCloseTo(0.03);
  });

  it('record() accumulates optional cache fields', () => {
    const t = new CostTracker();
    t.record({ inputTokens: 10, outputTokens: 5, costUsd: 0.001, cacheReadTokens: 50, cacheCreationTokens: 20 });
    t.record({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 }); // no cache fields
    expect(t.cacheReadTokens).toBe(50);
    expect(t.cacheCreationTokens).toBe(20);
    expect(t.inputTokens).toBe(20);
  });

  it('snapshot returns a defensive copy', () => {
    const t = new CostTracker();
    t.add({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
    const snap = t.snapshot();
    expect(snap.costUsd).toBeCloseTo(0.001);
    // Mutating the snapshot must not affect tracker internals
    snap.inputTokens = 9999;
    expect(t.inputTokens).toBe(10);
  });
});
