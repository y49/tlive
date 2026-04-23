import { describe, it, expect, vi } from 'vitest';
import { stopTaskCmd } from '../../../src/im/commands/stop-task.js';
import { buildCtx } from './_helpers.js';

describe('/stop-task', () => {
  it('usage on missing arg', async () => {
    const { ctx, replies } = buildCtx();
    await stopTaskCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Usage/);
  });

  it('stops subagent via session.stopTask', async () => {
    const stopTask = vi.fn(async () => undefined);
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', stopTask } as never,
    });
    await stopTaskCmd.run(ctx, ['agent-xyz']);
    expect(stopTask).toHaveBeenCalledWith('agent-xyz');
    expect(replies[0]).toMatch(/Task agent-xyz stopped/);
  });
});
