import { describe, it, expect } from 'vitest';
import { ForceReplyTracker } from '../../../src/platform/telegram/elicitation.js';

describe('ForceReplyTracker', () => {
  it('walks through fields in order', () => {
    const t = new ForceReplyTracker();
    t.begin('c1', 'u1', {
      requestId: 'r1',
      fields: [
        { name: 'a', label: 'A', type: 'text' },
        { name: 'b', label: 'B', type: 'text' },
      ],
      values: {}, cursor: 0,
    });
    const s1 = t.advance('c1', 'u1', 'alpha');
    expect(s1?.cursor).toBe(1);
    expect(s1?.values.a).toBe('alpha');
    const s2 = t.advance('c1', 'u1', 'beta');
    expect(s2?.cursor).toBe(2);
    expect(s2?.values).toEqual({ a: 'alpha', b: 'beta' });
    expect(t.peek('c1', 'u1')).toBeUndefined();
  });

  it('cancel clears state', () => {
    const t = new ForceReplyTracker();
    t.begin('c1', 'u1', { requestId: 'r1', fields: [{ name: 'a', label: 'A', type: 'text' }], values: {}, cursor: 0 });
    const s = t.cancel('c1', 'u1');
    expect(s?.requestId).toBe('r1');
    expect(t.peek('c1', 'u1')).toBeUndefined();
  });
});
