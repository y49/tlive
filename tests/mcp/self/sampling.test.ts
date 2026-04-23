// tests/mcp/self/sampling.test.ts
//
// Sampling helpers — no-op when client does not declare capability.

import { describe, it, expect, vi } from 'vitest';
import {
  sample, generateSessionTitle, rerankSearchHits,
  summarizeForLeaveNotification, generateDailyDigest, explainError,
} from '../../../src/mcp/self/sampling.js';

describe('sampling helpers', () => {
  it('sample returns null when client unsupported', async () => {
    const client = { supported: () => false, createMessage: vi.fn() };
    const res = await sample(client as never, [{ role: 'user', content: { type: 'text', text: 'hi' } }]);
    expect(res).toBeNull();
    expect(client.createMessage).not.toHaveBeenCalled();
  });

  it('sample returns text when client supports', async () => {
    const client = {
      supported: () => true,
      createMessage: vi.fn().mockResolvedValue({ content: { type: 'text', text: 'hello' }, stopReason: 'end_turn' }),
    };
    const res = await sample(client as never, [{ role: 'user', content: { type: 'text', text: 'hi' } }]);
    expect(res?.text).toBe('hello');
  });

  it('generateSessionTitle / summarizeForLeaveNotification / etc gracefully fallback', async () => {
    const client = { supported: () => false, createMessage: vi.fn() };
    expect(await generateSessionTitle(client as never, 'fix bug')).toBeNull();
    expect(await summarizeForLeaveNotification(client as never, ['a'])).toBeNull();
    expect(await generateDailyDigest(client as never, ['x'])).toBeNull();
    expect(await explainError(client as never, { code: 'oops', message: 'bad' })).toBeNull();
  });

  it('rerankSearchHits returns [] for empty candidates without calling client', async () => {
    const client = { supported: () => true, createMessage: vi.fn() };
    expect(await rerankSearchHits(client as never, 'q', [])).toEqual([]);
    expect(client.createMessage).not.toHaveBeenCalled();
  });

  it('rerankSearchHits parses index list', async () => {
    const client = {
      supported: () => true,
      createMessage: vi.fn().mockResolvedValue({ content: { type: 'text', text: '2, 0, 1' }, stopReason: 'end_turn' }),
    };
    const res = await rerankSearchHits(client as never, 'q', ['a', 'b', 'c']);
    expect(res).toEqual([2, 0, 1]);
  });
});
