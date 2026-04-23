import { describe, it, expect } from 'vitest';
import { pairingsCmd } from '../../../src/im/commands/pairings.js';
import { buildCtx } from './_helpers.js';

describe('/pairings', () => {
  it('lists bindings', async () => {
    const { ctx, replies } = buildCtx();
    await pairingsCmd.run(ctx, []);
    expect(replies[0]).toContain('telegram:12345');
    expect(replies[0]).toContain('primary');
  });
});
