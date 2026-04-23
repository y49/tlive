import { describe, it, expect } from 'vitest';
import { statusCmd } from '../../../src/im/commands/status.js';
import { buildCtx } from './_helpers.js';

describe('/status', () => {
  it('replies with session status', async () => {
    const snapshot = () => ({
      id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', kind: 'local',
      provider: 'claude', workspaceId: 'ws', workdir: '/tmp',
      status: { phase: 'idle', queuedInputs: 0 },
      title: 'demo',
      cost: { totalCost: 0.01, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      createdAt: 0, lastActivityAt: 0,
    });
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', snapshot } as never,
    });
    await statusCmd.run(ctx, []);
    expect(replies[0]).toContain('abcd1234');
    expect(replies[0]).toContain('idle');
    expect(replies[0]).toContain('$0.0100');
  });
});
