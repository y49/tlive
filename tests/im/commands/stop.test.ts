import { describe, it, expect, vi } from 'vitest';
import { stopCmd } from '../../../src/im/commands/stop.js';
import { buildCtx } from './_helpers.js';

describe('/stop', () => {
  it('interrupts the active session', async () => {
    const interrupt = vi.fn(async () => undefined);
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', interrupt } as never,
    });
    await stopCmd.run(ctx, []);
    expect(interrupt).toHaveBeenCalled();
    expect(replies[0]).toMatch(/Interrupted/);
  });
});
