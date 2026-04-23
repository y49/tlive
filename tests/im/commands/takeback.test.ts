import { describe, it, expect } from 'vitest';
import { takebackCmd } from '../../../src/im/commands/takeback.js';
import { buildCtx } from './_helpers.js';

describe('/takeback', () => {
  it('replies when no active session', async () => {
    const { ctx, replies } = buildCtx({ workspace: { activeSessionId: null } });
    await takebackCmd.run(ctx, []);
    expect(replies[0]).toMatch(/No active session/);
  });

  it('resumes a stopped active session', async () => {
    const { ctx, replies, sessionCalls } = buildCtx({
      workspace: { activeSessionId: 'sess-gone-0000-0000-0000' },
    });
    await takebackCmd.run(ctx, []);
    expect(sessionCalls.some((c) => c.method === 'resumeLocal')).toBe(true);
    expect(replies[0]).toMatch(/Took back/);
  });
});
