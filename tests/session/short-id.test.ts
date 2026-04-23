// tests/session/short-id.test.ts

import { describe, it, expect } from 'vitest';
import { shortId, resolveByPrefix } from '../../src/util/short-id.js';

describe('shortId', () => {
  it('strips dashes and takes first 8 hex chars', () => {
    expect(shortId('abc12345-6789-aaaa-bbbb-cccccccccccc')).toBe('abc12345');
  });
  it('handles ids shorter than 8 hex', () => {
    expect(shortId('abc-def')).toBe('abcdef');
  });
});

describe('resolveByPrefix', () => {
  const candidates = [
    { id: 'abc12345-aaa' },
    { id: 'abc19999-bbb' },
    { id: 'def56789-ccc' },
  ];
  const getId = (x: { id: string }) => x.id;

  it('rejects prefixes shorter than 4 chars', () => {
    const r = resolveByPrefix(candidates, 'abc', getId);
    expect(r.resolved).toBeNull();
    expect(r.ambiguous).toEqual([]);
  });

  it('resolves unambiguous short-alias prefix', () => {
    const r = resolveByPrefix(candidates, 'def5', getId);
    expect(r.resolved?.id).toBe('def56789-ccc');
  });

  it('flags ambiguous prefix', () => {
    const r = resolveByPrefix(candidates, 'abc1', getId);
    expect(r.resolved).toBeNull();
    expect(r.ambiguous).toHaveLength(2);
  });

  it('returns empty for non-matching prefix', () => {
    const r = resolveByPrefix(candidates, 'zzzz', getId);
    expect(r.resolved).toBeNull();
    expect(r.ambiguous).toEqual([]);
  });

  it('matches full id as prefix', () => {
    const r = resolveByPrefix(candidates, 'abc12345-aaa', getId);
    expect(r.resolved?.id).toBe('abc12345-aaa');
  });
});
