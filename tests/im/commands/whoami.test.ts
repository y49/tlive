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

  it('shows unbound hint and lists workspaces when chat is not bound', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await whoamiCmd.run(ctx, []);
    expect(replies.join('\n')).toMatch(/not bound to a workspace/);
    expect(replies.join('\n')).toMatch(/Use.*bind/);
  });
});
