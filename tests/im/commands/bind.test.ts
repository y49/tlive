import { describe, it, expect } from 'vitest';
import { bindCmd } from '../../../src/im/commands/bind.js';
import { buildCtx } from './_helpers.js';

describe('/bind', () => {
  it('binds current chat when user is admin of exactly one workspace', async () => {
    const { ctx, replies, workspaceCalls } = buildCtx({
      workspace: {
        id: 'ws-aaa', name: 'tlive', bindings: [], roles: { 'u1': 'admin' },
      } as never,
      userId: 'u1',
      chatId: '12345',
    });
    await bindCmd.run(ctx, []);
    expect(workspaceCalls.some((c) => c.method === 'addBinding')).toBe(true);
    expect(replies[0]).toMatch(/Bound this chat/);
    expect(replies[0]).toContain('tlive');
  });

  it('binds to specified workspace name when given', async () => {
    const { ctx, replies, workspaceCalls } = buildCtx({
      workspace: {
        id: 'ws-aaa', name: 'tlive', bindings: [], roles: { 'u1': 'admin' },
      } as never,
      userId: 'u1',
    });
    await bindCmd.run(ctx, ['tlive']);
    expect(workspaceCalls.some((c) => c.method === 'addBinding')).toBe(true);
    expect(replies[0]).toMatch(/Bound/);
  });

  it('refuses with helpful message when user is admin of no workspace', async () => {
    const { ctx, replies, workspaceCalls } = buildCtx({
      workspace: {
        id: 'ws-aaa', name: 'tlive', bindings: [], roles: {},
      } as never,
      userId: 'u1',
    });
    await bindCmd.run(ctx, []);
    expect(workspaceCalls.some((c) => c.method === 'addBinding')).toBe(false);
    expect(replies[0]).toMatch(/not admin of any workspace/i);
    expect(replies[0]).toMatch(/adminUserId/);
  });

  it('refuses /bind <name> when user is not admin of that name', async () => {
    const { ctx, replies, workspaceCalls } = buildCtx({
      workspace: {
        id: 'ws-aaa', name: 'tlive', bindings: [], roles: {},
      } as never,
      userId: 'u1',
    });
    await bindCmd.run(ctx, ['tlive']);
    expect(workspaceCalls.some((c) => c.method === 'addBinding')).toBe(false);
    expect(replies[0]).toMatch(/No workspace named/i);
  });

  it('reports already-bound (same workspace) as idempotent', async () => {
    const { ctx, replies, workspaceCalls } = buildCtx({
      workspace: {
        id: 'ws-aaa', name: 'tlive',
        bindings: [{ channelType: 'telegram', chatId: '12345', role: 'primary' }],
        roles: { 'u1': 'admin' },
      } as never,
      userId: 'u1',
      chatId: '12345',
    });
    await bindCmd.run(ctx, []);
    expect(workspaceCalls.some((c) => c.method === 'addBinding')).toBe(false);
    expect(replies[0]).toMatch(/Already bound/i);
  });
});
