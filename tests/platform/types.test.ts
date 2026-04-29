import { describe, it, expect } from 'vitest';
import { RateLimitError } from '../../src/platform/types.js';

describe('RateLimitError', () => {
  it('携带 retryAfterMs / platform / message', () => {
    const e = new RateLimitError(2500, 'telegram', 'Too Many Requests');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('RateLimitError');
    expect(e.retryAfterMs).toBe(2500);
    expect(e.platform).toBe('telegram');
    expect(e.message).toBe('Too Many Requests');
  });
});
