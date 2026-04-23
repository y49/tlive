import { describe, it, expect, vi } from 'vitest';
import { rewindCmd } from '../../../src/im/commands/rewind.js';
import { buildCtx } from './_helpers.js';

describe('/rewind', () => {
  it('usage on missing msg-id', async () => {
    const { ctx, replies } = buildCtx();
    await rewindCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Usage/);
  });

  it('rewinds active session', async () => {
    const rewindFiles = vi.fn(async () => ({ canRewind: true, filesChanged: 1, insertions: 2, deletions: 0 }));
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', rewindFiles } as never,
    });
    await rewindCmd.run(ctx, ['msg-1']);
    expect(rewindFiles).toHaveBeenCalled();
    expect(replies[0]).toMatch(/Rewound/);
  });
});
