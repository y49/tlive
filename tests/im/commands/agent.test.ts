import { describe, it, expect } from 'vitest';
import { agentCmd } from '../../../src/im/commands/agent.js';
import { buildCtx } from './_helpers.js';

describe('/agent', () => {
  it('lists agents via supportedAgents', async () => {
    const supportedAgents = async () => [{ name: 'coder', description: 'writes code' }];
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', supportedAgents } as never,
    });
    await agentCmd.run(ctx, ['list']);
    expect(replies[0]).toContain('coder');
  });

  it('create reports scaffold', async () => {
    const { ctx, replies } = buildCtx();
    await agentCmd.run(ctx, ['create', 'mybot', '"does', 'things"']);
    expect(replies[0]).toMatch(/Agent mybot created/);
  });
});
