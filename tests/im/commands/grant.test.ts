import { describe, it, expect } from 'vitest';
import { grantCmd } from '../../../src/im/commands/grant.js';
import { buildCtx } from './_helpers.js';

describe('/grant', () => {
  it('rejects invalid role', async () => {
    const { ctx, replies } = buildCtx();
    await grantCmd.run(ctx, ['u2', 'owner']);
    expect(replies[0]).toMatch(/Invalid role/);
  });

  it('sets role in workspace', async () => {
    const { ctx, replies, workspaceCalls } = buildCtx();
    await grantCmd.run(ctx, ['@u2', 'operator']);
    expect(workspaceCalls.some((c) => c.method === 'setRole' && (c.args as unknown[])[1] === 'u2')).toBe(true);
    expect(replies[0]).toMatch(/Granted operator/);
  });
});
