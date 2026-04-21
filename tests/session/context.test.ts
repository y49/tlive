import { describe, it, expect } from 'vitest';
import { SessionContext } from '../../src/session/context.js';

describe('SessionContext', () => {
  it('derives workspaceName from workdir when not given', () => {
    const ctx = SessionContext.create({
      sessionId: 's1', workdir: '/home/a/projects/foo',
      workspaceId: 'ws-1', provider: 'claude',
    });
    expect(ctx.snapshot.workspaceName).toBe('foo');
  });

  it('respects explicit workspaceName', () => {
    const ctx = SessionContext.create({
      sessionId: 's1', workdir: '/home/a/projects/foo',
      workspaceId: 'ws-1', workspaceName: 'Custom', provider: 'codex',
    });
    expect(ctx.snapshot.workspaceName).toBe('Custom');
  });

  it('falls back to "unknown" for root-like workdirs', () => {
    const ctx = SessionContext.create({
      sessionId: 's1', workdir: '/', workspaceId: 'ws-1', provider: 'claude',
    });
    expect(ctx.snapshot.workspaceName).toBe('unknown');
  });

  it('stamps createdAt by default', () => {
    const before = Date.now();
    const ctx = SessionContext.create({
      sessionId: 's1', workdir: '/x', workspaceId: 'ws-1', provider: 'claude',
    });
    expect(ctx.snapshot.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('preserves explicit createdAt for resume', () => {
    const ctx = SessionContext.create({
      sessionId: 's1', workdir: '/x', workspaceId: 'ws-1',
      provider: 'claude', createdAt: 1_700_000_000_000,
    });
    expect(ctx.snapshot.createdAt).toBe(1_700_000_000_000);
  });
});
