import { describe, it, expect, vi } from 'vitest';
import { timeTravelCmd } from '../../../src/im/commands/time-travel.js';
import { buildCtx } from './_helpers.js';

describe('/time-travel', () => {
  it('usage on missing args', async () => {
    const { ctx, replies } = buildCtx();
    await timeTravelCmd.run(ctx, ['abcd']);
    expect(replies[0]).toMatch(/Usage/);
  });

  it('calls runtime.rewindFiles with dryRun true', async () => {
    const rewindFiles = vi.fn(async () => ({ canRewind: true, filesChanged: 2, insertions: 5, deletions: 1 }));
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', kind: 'local', rewindFiles } as never,
    });
    await timeTravelCmd.run(ctx, ['abcd1234', 'msg-1']);
    expect(rewindFiles).toHaveBeenCalledWith('msg-1', { dryRun: true });
    expect(replies[0]).toMatch(/Rewind preview/);
  });
});
