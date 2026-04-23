import { describe, it, expect, vi } from 'vitest';
import { modeCmd } from '../../../src/im/commands/mode.js';
import { buildCtx } from './_helpers.js';

describe('/mode', () => {
  it('rejects unknown mode', async () => {
    const { ctx, replies } = buildCtx();
    await modeCmd.run(ctx, ['unicorn']);
    expect(replies[0]).toMatch(/Unknown mode/);
  });

  it('applies valid mode', async () => {
    const setPermissionMode = vi.fn(async () => undefined);
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', setPermissionMode } as never,
    });
    await modeCmd.run(ctx, ['plan']);
    expect(setPermissionMode).toHaveBeenCalledWith('plan');
    expect(replies[0]).toMatch(/Permission mode set to plan/);
  });
});
