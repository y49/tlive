import { describe, it, expect } from 'vitest';
import { cacheBadge, formatCacheBadge } from '../../../src/im/render/cache-badge.js';

describe('cacheBadge', () => {
  it('returns unknown when warmUntilMs missing', () => {
    expect(cacheBadge({}).state).toBe('unknown');
    expect(formatCacheBadge({})).toBe('');
  });

  it('returns hot with remaining seconds', () => {
    const b = cacheBadge({ warmUntilMs: 100_000, nowMs: 98_000 });
    expect(b.state).toBe('hot');
    expect(b.emoji).toBe('⚡️');
    expect(b.label).toBe('hot (2s)');
    expect(formatCacheBadge({ warmUntilMs: 100_000, nowMs: 98_000 })).toBe('⚡️ hot (2s)');
  });

  it('returns cold when expired', () => {
    const b = cacheBadge({ warmUntilMs: 100, nowMs: 200 });
    expect(b.state).toBe('cold');
    expect(b.emoji).toBe('❄️');
    expect(formatCacheBadge({ warmUntilMs: 100, nowMs: 200 })).toBe('❄️ cold');
  });
});
