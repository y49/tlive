// tests/e2e/commands/sessions.test.ts
//
// e2e tests for the /sessions command and session:resume callback.
//
// Covers:
//   - /sessions (no args) lists only sessions owned by the calling chat
//   - /sessions --all lists sessions across all chats
//   - any user may view /sessions (chat-trust, no permission denial)
//
// Uses setupBootstrap() so real command dispatch + real CallbackRouter are
// exercised. chat-trust: no role gating.

import { describe, it, expect, afterEach } from 'vitest';
import { setupBootstrap, type BootstrapFixture } from '../../_helpers/bootstrap-fixture.js';

let env: BootstrapFixture | undefined;

afterEach(async () => {
  await env?.cleanup?.();
  env = undefined;
});

describe('/sessions — per-chat filter + --all + chat-trust', () => {
  it('text /sessions in c1 lists only c1-owned sessions, not cF sessions', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test-ws', workdir: '/tmp/tlive-e2e-sessions-1',
        bindings: [
          { channelType: 'telegram', chatId: 'c1' },
          { channelType: 'feishu', chatId: 'cF' },
        ],
      }],
    });

    // Seed a session owned by c1 (telegram).
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm-new-c1',
    });
    // Capture the c1 session alias from the reply.
    const newReplyC1 = env.replies.find((r) => /✅ 会话/.test(r)) ?? '';
    expect(newReplyC1).toMatch(/✅ 会话/);

    // Seed a session owned by cF (feishu).
    await env.handleInbound({
      channelType: 'feishu', chatId: 'cF', userId: 'u-admin',
      text: '/new', messageId: 'm-new-cF',
    });

    // Query /sessions from c1 — should list only c1's session.
    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/sessions', messageId: 'm-sessions',
    });

    const reply = env.replies.join('\n');
    // Reply should be non-empty and show the c1 session count (1 session).
    expect(reply.length).toBeGreaterThan(0);
    expect(reply).toMatch(/1 sessions/);

    // The feishu-owned session must NOT appear (scope is c1 only).
    // The c1 binding has one session → "当前 chat 的会话 (1 sessions)".
    expect(reply).toMatch(/当前 chat 的会话/);
    // Not the --all header.
    expect(reply).not.toMatch(/所有会话/);
  });

  it('text /sessions --all lists sessions from all chats', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w2', name: 'test-ws', workdir: '/tmp/tlive-e2e-sessions-2',
        bindings: [
          { channelType: 'telegram', chatId: 'c1' },
          { channelType: 'feishu', chatId: 'cF' },
        ],
      }],
    });

    // Seed two sessions in different chats.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm-new-c1',
    });
    await env.handleInbound({
      channelType: 'feishu', chatId: 'cF', userId: 'u-admin',
      text: '/new', messageId: 'm-new-cF',
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/sessions --all', messageId: 'm-sessions-all',
    });

    const reply = env.replies.join('\n');
    expect(reply.length).toBeGreaterThan(0);
    // --all scope shows both sessions.
    expect(reply).toMatch(/2 sessions/);
    expect(reply).toMatch(/所有会话/);
  });

  it('observer can /sessions (read-only) without permission denial', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w3', name: 'test-ws', workdir: '/tmp/tlive-e2e-sessions-3',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-anon',
      text: '/sessions', messageId: 'm-sessions-obs',
    });

    // Should NOT reply with permission denial.
    expect(env.replies.some((r) => /权限不足|无权限/.test(r))).toBe(false);
    // Should reply with the (empty) sessions list.
    expect(env.replies.some((r) => /暂无会话|sessions/.test(r))).toBe(true);
  });

});

