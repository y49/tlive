// tests/e2e/commands/new.test.ts
//
// e2e tests for the /new command. Exercises the full dispatch path (text
// command via dispatch() + callback via CallbackRouter.route()) with:
//   - Text /new in a bound workspace → session created (chat-trust: any user)
//   - Text /new with an existing session → confirm-replace card shown
//   - Callback [🆕 new] (session:new) → hint to send message or prompt
//   - Text /new in an unbound chat → bind hint
//
// All tests use setupBootstrap() which exercises real command registry
// dispatch + real CallbackRouter. chat-trust: no role gating.

import { describe, it, expect, afterEach } from 'vitest';
import { setupBootstrap, type BootstrapFixture } from '../../_helpers/bootstrap-fixture.js';

let env: BootstrapFixture | undefined;

afterEach(async () => {
  await env?.cleanup?.();
  env = undefined;
});

describe('/new — text + button + chat-trust', () => {
  it('text /new starts a new session for the chat (any user)', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test-ws', workdir: '/tmp/tlive-e2e-1',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-any',
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
        // Pre-seed an active session id in the binding.
        bindings: [{ channelType: 'telegram', chatId: 'c1', activeSessionId: 'existing-session-id' }],
      }],
    });

    // Reply interception: capture replyMarkup via adapter calls.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-any',
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

  it('callback session:new (no active session) → hint to send a message', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w3', name: 'test-ws', workdir: '/tmp/tlive-e2e-3',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-any',
      messageId: 'm0', callbackData: 'session:new',
    });

    // No active session → hint path (CallbackRouter.handleSessionNew §hint).
    expect(env.replies.some((r) => /发送一条消息/.test(r))).toBe(true);
  });

  it('callback session:new (has active session) → confirm-replace prompt', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w4', name: 'test-ws', workdir: '/tmp/tlive-e2e-4',
        bindings: [{ channelType: 'telegram', chatId: 'c1', activeSessionId: 'some-session' }],
      }],
    });

    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-any',
      messageId: 'm0', callbackData: 'session:new',
    });

    // Has active session → prompt to confirm (session:new:prompt action).
    expect(env.replies.some((r) => /当前已有活跃会话/.test(r))).toBe(true);
  });

  it('text /new in unbound chat → workspace bind hint', async () => {
    env = setupBootstrap({ workspaces: [] });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c-unbound', userId: 'u-any',
      text: '/new', messageId: 'm1',
    });

    // Unbound chat → /new replies with "未绑定工作区"
    expect(env.replies.some((r) => /未绑定工作区/.test(r))).toBe(true);
  });

  it('chat-trust: any user in bound chat can run /new (no role check)', async () => {
    // Three separate env instances to avoid reply accumulation confusion
    for (const userId of ['u-admin', 'u-random-lurker', 'u-nobody']) {
      const e = setupBootstrap({
        workspaces: [{
          id: 'w6', name: 'ws', workdir: '/tmp/e2e-6',
          bindings: [{ channelType: 'telegram', chatId: 'c1' }],
        }],
      });
      await e.handleInbound({
        channelType: 'telegram', chatId: 'c1',
        userId, text: '/new', messageId: 'm-new',
      });
      // Each should create or confirm a session (not deny)
      const denied = e.replies.some((r) => /权限不足|无权限/.test(r));
      expect(denied).toBe(false);
      await e.cleanup?.();
    }
  });
});
