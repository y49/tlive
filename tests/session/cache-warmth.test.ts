// tests/session/cache-warmth.test.ts

import { describe, it, expect, vi } from 'vitest';
import { CacheWarmth } from '../../src/session/cache-warmth.js';

describe('CacheWarmth', () => {
  it('reports cold before any assistant response', () => {
    const cw = new CacheWarmth();
    expect(cw.isWarm()).toBe(false);
    expect(cw.warmUntilMs).toBeNull();
  });

  it('markAssistantResponse sets warm window', () => {
    let now = 1_000;
    const cw = new CacheWarmth({ now: () => now });
    cw.markAssistantResponse();
    expect(cw.isWarm()).toBe(true);
    expect(cw.warmUntilMs).toBe(1_000 + 5 * 60 * 1000);
  });

  it('isWarm flips false after ttl', () => {
    let now = 1_000;
    const cw = new CacheWarmth({ now: () => now });
    cw.markAssistantResponse(1_000);
    now = 1_000 + 5 * 60 * 1000 + 1;
    expect(cw.isWarm()).toBe(false);
  });

  it('subscribe fires on markAssistantResponse', () => {
    const cw = new CacheWarmth();
    const heard: number[] = [];
    cw.subscribe((ev) => heard.push(ev.warmUntilMs ?? -1));
    cw.markAssistantResponse();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeGreaterThan(0);
  });

  it('onPrewarmTick fires at warmUntilMs - prewarmLeadMs', () => {
    vi.useFakeTimers();
    try {
      const cw = new CacheWarmth({ cacheTtlMs: 1000, prewarmLeadMs: 200 });
      const hit = vi.fn();
      cw.onPrewarmTick(hit);
      cw.markAssistantResponse();
      vi.advanceTimersByTime(750);
      expect(hit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(hit).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('dispose tears down timers + listeners', () => {
    const cw = new CacheWarmth();
    cw.markAssistantResponse();
    cw.dispose();
    expect(cw.isWarm()).toBe(true); // state preserved; only side effects cleaned
  });
});
