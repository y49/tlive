import { describe, it, expect } from 'vitest';
import { verboseCmd } from '../../../src/im/commands/verbose.js';
import { buildCtx } from './_helpers.js';

describe('/verbose', () => {
  it('rejects invalid value', async () => {
    const { ctx, replies } = buildCtx();
    await verboseCmd.run(ctx, ['maybe']);
    expect(replies[0]).toMatch(/Usage/);
  });

  it('sets verbose on', async () => {
    const { ctx, replies } = buildCtx();
    await verboseCmd.run(ctx, ['1']);
    expect(replies[0]).toMatch(/Verbose on/);
  });
});
