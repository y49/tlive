import { describe, it, expect } from 'vitest';
import { costCmd } from '../../../src/im/commands/cost.js';
import { buildCtx } from './_helpers.js';

describe('/cost', () => {
  it('reports live-only fallback when no rollupStore', async () => {
    const { ctx, replies } = buildCtx();
    await costCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Cost \(today\)/);
  });

  it('uses rollup store when wired', async () => {
    const { ctx, replies } = buildCtx();
    ctx.rollupStore = {
      load: async () => [
        { workspaceId: 'w1', sdkSessionId: 's1', dateKey: '2026-04-22', deltaUsd: 0.5, deltaIn: 100, deltaOut: 200, at: Date.now() },
      ],
    } as unknown as Parameters<typeof costCmd.run>[0]['rollupStore'];
    await costCmd.run(ctx, ['week', '--global']);
    expect(replies[0]).toContain('Cost week');
  });
});
