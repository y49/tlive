import { describe, it, expect } from 'vitest';
import { companionCmd } from '../../../src/im/commands/companion.js';
import { buildCtx } from './_helpers.js';

describe('/companion', () => {
  it('status defaults to disabled', async () => {
    const { ctx, replies } = buildCtx();
    await companionCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Companion status/);
  });

  it('accept requires agent arg', async () => {
    const { ctx, replies } = buildCtx();
    await companionCmd.run(ctx, ['accept']);
    expect(replies[0]).toMatch(/Usage/);
  });
});
