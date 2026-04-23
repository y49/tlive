import { describe, it, expect } from 'vitest';
import { sessionsCmd } from '../../../src/im/commands/sessions.js';
import { buildCtx } from './_helpers.js';

describe('/sessions', () => {
  it('reports no live sessions', async () => {
    const { ctx, replies } = buildCtx();
    await sessionsCmd.run(ctx, []);
    expect(replies[0]).toMatch(/No live sessions/);
  });

  it('lists live sessions', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', title: 'demo' } as never,
    });
    await sessionsCmd.run(ctx, []);
    expect(replies[0]).toContain('abcd1234');
  });
});
