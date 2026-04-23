import { describe, it, expect } from 'vitest';
import { effortCmd } from '../../../src/im/commands/effort.js';
import { buildCtx } from './_helpers.js';

describe('/effort', () => {
  it('rejects invalid effort', async () => {
    const { ctx, replies } = buildCtx();
    await effortCmd.run(ctx, ['extreme']);
    expect(replies[0]).toMatch(/Invalid effort/);
  });

  it('sets effort', async () => {
    const { ctx, replies } = buildCtx();
    await effortCmd.run(ctx, ['high']);
    expect(replies[0]).toMatch(/Effort set to high/);
  });
});
