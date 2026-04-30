import { describe, it, expect } from 'vitest';
import { modelMaxContextFor } from '../../../src/runtime/claude/model-context.js';

describe('modelMaxContextFor', () => {
  it('returns 200k for the current Claude 4.x family', () => {
    expect(modelMaxContextFor('claude-opus-4-7')).toBe(200_000);
    expect(modelMaxContextFor('claude-opus-4-7-20251015')).toBe(200_000);
    expect(modelMaxContextFor('claude-sonnet-4-5')).toBe(200_000);
    expect(modelMaxContextFor('claude-sonnet-4-5-20250929')).toBe(200_000);
    expect(modelMaxContextFor('claude-haiku-4-5')).toBe(200_000);
  });

  it('returns 1M for 1m-context variants', () => {
    expect(modelMaxContextFor('claude-sonnet-4-5-1m')).toBe(1_000_000);
    expect(modelMaxContextFor('claude-sonnet-4-5-1m-20250929')).toBe(1_000_000);
  });

  it('returns 1M for SDK [1m] / (1m) suffix variants (v3.2.1)', () => {
    // SDK exposes claude-opus-4-6[1m] when the anthropic-beta context-1m flag is set
    expect(modelMaxContextFor('claude-opus-4-6[1m]')).toBe(1_000_000);
    expect(modelMaxContextFor('claude-sonnet-4-5(1m)')).toBe(1_000_000);
    expect(modelMaxContextFor('claude-sonnet-4_1m')).toBe(1_000_000);
  });

  it('falls back to 200k for unknown / null / empty', () => {
    expect(modelMaxContextFor(null)).toBe(200_000);
    expect(modelMaxContextFor(undefined)).toBe(200_000);
    expect(modelMaxContextFor('')).toBe(200_000);
    expect(modelMaxContextFor('some-future-model-x')).toBe(200_000);
  });
});
