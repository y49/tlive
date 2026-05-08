import { describe, it, expect } from 'vitest';
import { stopCmd } from '../../../src/im/commands/stop.js';
import { buildCtx } from './_helpers.js';

describe('/stop', () => {
  it('interrupts active session', async () => {
    let interrupted = 0;
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      interrupt: async () => { interrupted++; },
      getStatus: () => 'active' as const,
    };
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await stopCmd.run(ctx, []);
    expect(interrupted).toBe(1);
    expect(replies[0]).toMatch(/中断|已停|stop/i);
  });

  it('replies "no active turn" when session idle', async () => {
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      interrupt: async () => {},
      getStatus: () => 'idle' as const,
    };
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await stopCmd.run(ctx, []);
    expect(replies[0]).toMatch(/没有进行中|no.*turn|idle/i);
  });

  it('no active session: friendly message', async () => {
    const { ctx, replies } = buildCtx({ workspace: { activeSessionId: null } });
    await stopCmd.run(ctx, []);
    expect(replies[0]).toMatch(/活跃会话|No active session/i);
  });

  it('handles interrupt error gracefully', async () => {
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      interrupt: async () => { throw new Error('mock fail'); },
      getStatus: () => 'active' as const,
    };
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await stopCmd.run(ctx, []);
    expect(replies[0]).toMatch(/中断失败|mock fail/);
  });
});
