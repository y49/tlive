import { describe, it, expect } from 'vitest';
import { modelsCmd } from '../../../src/im/commands/models.js';
import { buildCtx } from './_helpers.js';

describe('/models', () => {
  it('lists models', async () => {
    const supportedModels = async () => [{ id: 'claude-sonnet-4', displayName: 'Sonnet 4' }];
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', supportedModels } as never,
    });
    await modelsCmd.run(ctx, []);
    expect(replies[0]).toContain('Sonnet 4');
  });
});
