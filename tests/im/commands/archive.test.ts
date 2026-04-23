import { describe, it, expect } from 'vitest';
import { archiveCmd } from '../../../src/im/commands/archive.js';
import { buildCtx } from './_helpers.js';

describe('/archive', () => {
  it('stops the target session', async () => {
    const { ctx, replies, sessionCalls } = buildCtx({
      activeSession: { id: 'sess-aaaa-aaaa-aaaa-aaaa', shortAlias: 'aaaabbbb' } as never,
    });
    await archiveCmd.run(ctx, ['aaaabbbb']);
    expect(sessionCalls.some((c) => c.method === 'stop')).toBe(true);
    expect(replies[0]).toMatch(/Archived/);
  });
});
