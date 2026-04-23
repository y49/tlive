import { describe, it, expect } from 'vitest';
import { agentsCmd } from '../../../src/im/commands/agents.js';
import { buildCtx } from './_helpers.js';

describe('/agents', () => {
  it('lists subagents', async () => {
    const supportedAgents = async () => [{ name: 'researcher', description: 'does research' }];
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', supportedAgents } as never,
    });
    await agentsCmd.run(ctx, []);
    expect(replies[0]).toContain('researcher');
  });
});
