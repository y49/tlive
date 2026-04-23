import { describe, it, expect, vi } from 'vitest';
import { cancelQueuedCmd } from '../../../src/im/commands/cancel-queued.js';
import { buildCtx } from './_helpers.js';

describe('/cancel-queued', () => {
  it('reports empty queue', async () => {
    const queue = { size: () => 0, cancelByIndex: vi.fn() };
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', queue } as never,
    });
    await cancelQueuedCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Queue is empty/);
  });

  it('cancels index', async () => {
    const cancelByIndex = vi.fn(() => ({ id: 'q1', text: 'my queued', queuedAt: Date.now() }));
    const queue = { size: () => 2, cancelByIndex };
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', queue } as never,
    });
    await cancelQueuedCmd.run(ctx, ['0']);
    expect(cancelByIndex).toHaveBeenCalledWith(0);
    expect(replies[0]).toMatch(/Cancelled queued input #0/);
  });
});
