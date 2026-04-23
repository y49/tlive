import { describe, it, expect } from 'vitest';
import { killCmd } from '../../../src/im/commands/kill.js';
import { buildCtx } from './_helpers.js';

describe('/kill', () => {
  it('stops the active session + clears binding', async () => {
    const { ctx, replies, sessionCalls, workspaceCalls } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234' } as never,
    });
    await killCmd.run(ctx, []);
    expect(sessionCalls.some((c) => c.method === 'stop')).toBe(true);
    expect(workspaceCalls.some((c) => c.method === 'clearActiveSession')).toBe(true);
    expect(replies[0]).toMatch(/Killed/);
  });
});
