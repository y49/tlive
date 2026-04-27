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

  it('binds when chat is unbound but user is admin of some workspace (late-binding flow)', async () => {
    const { ctx, replies, workspaceCalls } = buildCtx({
      workspace: null,
      otherWorkspaces: [{ id: 'ws-tlive', name: 'tlive', roles: { 'u1': 'admin' } }],
      userId: 'u1',
      chatId: '99999',
    });
    await bindCmd.run(ctx, []);
    expect(workspaceCalls.some((c) => c.method === 'addBinding')).toBe(true);
    expect(replies[0]).toMatch(/Bound this chat/);
    expect(replies[0]).toContain('tlive');
  });

  it('refuses cross-workspace re-bind and points at /mirror remove', async () => {
    const { ctx, replies, workspaceCalls } = buildCtx({
      // Currently bound to workspace A:
      workspace: { id: 'ws-A', name: 'A', bindings: [{ channelType: 'telegram', chatId: '12345', role: 'primary' }], roles: {} } as never,
      // User admins workspace B:
      otherWorkspaces: [{ id: 'ws-B', name: 'B', roles: { 'u1': 'admin' } }],
      userId: 'u1',
      chatId: '12345',
    });
    await bindCmd.run(ctx, ['B']);
    expect(workspaceCalls.some((c) => c.method === 'addBinding')).toBe(false);
    expect(replies[0]).toMatch(/already bound to "A"/i);
    expect(replies[0]).toMatch(/\/mirror remove/);
  });
});
