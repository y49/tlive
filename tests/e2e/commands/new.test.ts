// tests/e2e/commands/new.test.ts
//
// e2e tests for the /new command. Exercises the full dispatch path (text
// command via dispatch() + callback via CallbackRouter.route()) with:
//   - Text /new in a bound workspace (admin) → session created
//   - Text /new with an existing session → confirm-replace card shown
//   - Callback [🆕 new] (session:new) by admin → role allowed, reply sent
//   - Callback [🆕 new] by observer → permission denied
//   - Text /new in an unbound chat → bind hint
//
// All tests use setupBootstrap() which exercises real command registry
// dispatch + real CallbackRouter, so role gating + registry plumbing are
// covered without spinning up the daemon or real session runtimes.

import { describe, it, expect, afterEach } from 'vitest';
import { setupBootstrap, type BootstrapFixture } from '../../_helpers/bootstrap-fixture.js';

let env: BootstrapFixture | undefined;

afterEach(async () => {
  await env?.cleanup?.();
  env = undefined;
});

describe('/new — text + button + role', () => {
  it('text /new starts a new session for the chat (admin user)', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test-ws', workdir: '/tmp/tlive-e2e-1',
        roles: { 'u-admin': 'admin' },
        defaultRole: 'observer',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm1',
    });

    // Session should have been created and bound to the chat.
    const activeId = env.workspaceManager.getActiveSessionId('telegram', 'c1');
    expect(activeId).toBeTruthy();
    expect(activeId).toMatch(/sess-fake/);

    // Reply confirms new session.
    expect(env.replies.some((r) => /✅ 会话/.test(r))).toBe(true);
    expect(env.replies.some((r) => /test-ws/.test(r))).toBe(true);
  });

  it('text /new with existing session (no --force) → confirm-replace card with buttons', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w2', name: 'test-ws', workdir: '/tmp/tlive-e2e-2',
        roles: { 'u-admin': 'admin' },
        defaultRole: 'observer',
        // Pre-seed an active session id in the binding.
        bindings: [{ channelType: 'telegram', chatId: 'c1', activeSessionId: 'existing-session-id' }],
      }],
    });

    // Reply interception: capture replyMarkup via adapter calls.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm2',
    });

    // Should show the confirm-replace card (no new session created yet).
    expect(env.replies.some((r) => /已有活跃会话/.test(r))).toBe(true);

    // Inspect adapter.send calls for the replyMarkup with confirm/cancel buttons.
    const sendCalls = env.adapter.byKind('send');
    const cardCall = sendCalls.find((c) =>
      typeof c.args.text === 'string' && /已有活跃会话/.test(c.args.text) &&
      (c.args.replyMarkup as { buttons?: unknown[][] } | undefined)?.buttons != null,
    );
    expect(cardCall).toBeDefined();
    const buttons = ((cardCall!.args.replyMarkup as { buttons: Array<Array<{ text: string; callbackData: string }>> }).buttons).flat();
    expect(buttons.find((b) => b.callbackData === 'session:new:confirm')).toBeDefined();
    expect(buttons.find((b) => b.callbackData === 'session:new:cancel')).toBeDefined();

    // No new session bound (still the existing one).
    const activeId = env.workspaceManager.getActiveSessionId('telegram', 'c1');
    expect(activeId).toBe('existing-session-id');
  });

  it('callback session:new by admin (no active session) → hint to send a message', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w3', name: 'test-ws', workdir: '/tmp/tlive-e2e-3',
        roles: { 'u-admin': 'admin' },
        defaultRole: 'observer',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      messageId: 'm0', callbackData: 'session:new',
    });

    // No active session → hint path (CallbackRouter.handleSessionNew §hint).
    expect(env.replies.some((r) => /发送一条消息/.test(r))).toBe(true);
  });

  it('callback session:new by admin (has active session) → confirm-replace prompt', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w4', name: 'test-ws', workdir: '/tmp/tlive-e2e-4',
        roles: { 'u-admin': 'admin' },
        defaultRole: 'observer',
        bindings: [{ channelType: 'telegram', chatId: 'c1', activeSessionId: 'some-session' }],
      }],
    });

    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      messageId: 'm0', callbackData: 'session:new',
    });

    // Has active session → prompt to confirm (session:new:prompt action).
    expect(env.replies.some((r) => /当前已有活跃会话/.test(r))).toBe(true);
  });

  it('callback session:new by observer → permission denied', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w5', name: 'test-ws', workdir: '/tmp/tlive-e2e-5',
        defaultRole: 'observer', // u-observer not in roles map
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-observer',
      messageId: 'm1', callbackData: 'session:new',
    });

    // Must reply with permission denied.
    expect(env.replies.some((r) => /权限不足/.test(r))).toBe(true);
  });

  it('text /new in unbound chat → workspace bind hint', async () => {
    env = setupBootstrap({ workspaces: [] });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c-unbound', userId: 'u-any',
      text: '/new', messageId: 'm1',
    });

    // Role for unbound chat → observer → dispatch denies /new (role:admin/operator required).
    // The reply should indicate no permission or unbound workspace.
    expect(env.replies.some((r) => /未绑定工作区|无权限/.test(r))).toBe(true);
  });

  it('workspace:bind callback elevates binder to admin, allowing /new immediately', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w6', name: 'ws', workdir: '/tmp/e2e-6',
        roles: {}, defaultRole: 'observer',
        bindings: [],
      }],
    });

    // Bind — binder should be claimAdmin'd
    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-first',
      messageId: 'm-bind', callbackData: 'workspace:bind:w6',
    });
    expect(env.workspaceManager.getRole('w6', 'u-first')).toBe('admin');

    // Create binding for the chat so /new can work.
    env.workspaceManager.bindChat({
      workspaceId: 'w6',
      channelType: 'telegram',
      chatId: 'c1',
    });

    // /new should succeed (not be role-denied)
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1',
      userId: 'u-first', text: '/new', messageId: 'm-new',
    });
    expect(env.workspaceManager.getActiveSessionId('telegram', 'c1')).toBeTruthy();
    await env.cleanup?.();
  });
});
