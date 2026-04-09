import { describe, it, expect } from 'vitest';
import { CostTracker } from '../../src/core/costTracker.js';

describe('CostTracker', () => {
  it('accumulates token usage', () => {
    const ct = new CostTracker();
    ct.addUsage({ input_tokens: 1000, output_tokens: 500 });
    ct.addUsage({ input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 800 });
    const s = ct.summary;
    expect(s.inputTokens).toBe(3000);
    expect(s.outputTokens).toBe(800);
    expect(s.cacheReadTokens).toBe(800);
  });

  it('calculates cost with default pricing', () => {
    const ct = new CostTracker();
    ct.addUsage({ input_tokens: 1_000_000, output_tokens: 100_000 });
    const s = ct.summary;
    expect(s.estimatedCostUsd).toBe(4.5);
  });

  it('formats human-readable summary', () => {
    const ct = new CostTracker();
    ct.addUsage({ input_tokens: 15200, output_tokens: 3100, cache_read_input_tokens: 2800 });
    const text = ct.formatSummary();
    expect(text).toContain('15.2k in');
    expect(text).toContain('3.1k out');
    expect(text).toContain('2.8k cached');
    expect(text).toContain('Cost: ~$');
  });
});
