import { describe, it, expect } from 'vitest';
import { stopCmd } from '../../../src/im/commands/stop.js';
import { buildCtx } from './_helpers.js';

describe('/stop', () => {
  it('replies with stub TODO (full impl in Task 8)', async () => {
    const { ctx, replies } = buildCtx();
    await stopCmd.run(ctx, []);
    expect(replies[0]).toMatch(/TODO: stop/);
  });
});
