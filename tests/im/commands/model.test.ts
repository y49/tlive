import { describe, it, expect, vi } from 'vitest';
import { modelCmd } from '../../../src/im/commands/model.js';
import { buildCtx } from './_helpers.js';

describe('/model', () => {
  it('shows current model with no args', async () => {
    const { ctx, replies } = buildCtx();
    await modelCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Current model/);
  });

  it('updates workspace default + session model', async () => {
    const setModel = vi.fn(async () => undefined);
    const { ctx, replies, workspaceCalls } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', setModel } as never,
    });
    await modelCmd.run(ctx, ['claude-sonnet-4']);
    expect(setModel).toHaveBeenCalledWith('claude-sonnet-4');
    expect(workspaceCalls.some((c) => c.method === 'save')).toBe(true);
    expect(replies[0]).toMatch(/Model set to claude-sonnet-4/);
  });
});
