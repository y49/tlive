import { describe, it, expect } from 'vitest';
import { SenderGuard } from '../sender-guard.js';

describe('SenderGuard', () => {
  it('allows everyone when allowlist is empty (trust configured chat)', () => {
    const g = new SenderGuard([]);
    expect(g.allows('telegram', 'anyone')).toBe(true);
    expect(g.allows('feishu', 'someone-else')).toBe(true);
  });

  it('allows only listed senders when configured', () => {
    const g = new SenderGuard([{ channel: 'telegram', userId: 'u1' }]);
    expect(g.allows('telegram', 'u1')).toBe(true);
    expect(g.allows('telegram', 'evil')).toBe(false);
    expect(g.allows('feishu', 'u1')).toBe(false);
  });
});
