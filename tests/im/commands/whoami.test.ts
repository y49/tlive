import { describe, it, expect } from 'vitest';
import { whoamiCmd } from '../../../src/im/commands/whoami.js';
import { buildCtx } from './_helpers.js';

describe('/whoami', () => {
  it('reports user + role + workspace', async () => {
    const { ctx, replies } = buildCtx({ username: 'alice', userId: 'u-alice' });
    await whoamiCmd.run(ctx, []);
    expect(replies[0]).toContain('@alice');
    expect(replies[0]).toContain('observer');
    expect(replies[0]).toContain('test-ws');
  });
});
