import { describe, it, expect } from 'vitest';
import { handoffToMeCmd } from '../../../src/im/commands/handoff-to-me.js';
import { buildCtx } from './_helpers.js';

describe('/handoff-to-me', () => {
  it('stops the active session but keeps activeSessionId', async () => {
    const { ctx, replies, sessionCalls, workspaceCalls } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234' } as never,
    });
    await handoffToMeCmd.run(ctx, []);
    expect(sessionCalls.some((c) => c.method === 'stop')).toBe(true);
    expect(workspaceCalls.some((c) => c.method === 'clearActiveSession')).toBe(false);
    expect(replies[0]).toMatch(/Handed off/);
  });
});
