import { describe, it, expect } from 'vitest';
import { prewarmCmd } from '../../../src/im/commands/prewarm.js';
import { buildCtx } from './_helpers.js';

describe('/prewarm', () => {
  it('defaults off', async () => {
    const { ctx, replies } = buildCtx();
    await prewarmCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Prewarm: off/);
  });

  it('flips to on', async () => {
    const { ctx, replies } = buildCtx();
    await prewarmCmd.run(ctx, ['on']);
    expect(replies[0]).toMatch(/Prewarm on/);
  });
});
