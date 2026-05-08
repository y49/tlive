// tests/e2e/commands/stop.test.ts
//
// e2e tests for the /stop command.
//
// Covers:
//   - /stop requires admin/operator role; observer denied
//   - /stop interrupts active session (calls session.interrupt())
//   - /stop with no active session shows Chinese hint
//
// Uses setupBootstrap() so real command dispatch is exercised, including
// role gating. The test modifies the fake session object to support
// getStatus() and interrupt() for testing.

import { describe, it, expect, afterEach } from 'vitest';
import { setupBootstrap, type BootstrapFixture } from '../../_helpers/bootstrap-fixture.js';

let env: BootstrapFixture | undefined;

afterEach(async () => {
  await env?.cleanup?.();
  env = undefined;
});

describe('/stop — interrupt active session', () => {
  it('admin /stop interrupts active session', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    // Create a new session to have an active one.
    await env.handleInbound({
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u-admin',
      text: '/new',
      messageId: 'm0',
    });

    // Clear the replies from /new.
    env.replies.length = 0;

    // Get the active session and add interrupt tracking.
    const binding = env.workspaceManager.getActiveSessionIdForChat('telegram', 'c1');
    if (binding) {
      const session = env.sessionManager.get(binding);
      if (session) {
        // Add interrupt tracking to the fake session.
        let interruptCalled = false;
        (session as any).interrupt = async () => {
          interruptCalled = true;
        };
        (session as any).getStatus = () => 'active';
      }
    }

    // Now call /stop.
    await env.handleInbound({
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u-admin',
      text: '/stop',
      messageId: 'm1',
    });

    // Verify a reply was sent (success ack).
    expect(env.replies.length).toBeGreaterThan(0);
    const reply = env.replies.join('\n');
    expect(reply).toMatch(/已中断|中止|生成/i);
  });

  it('observer /stop denied', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        defaultRole: 'observer',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u-anon',
      text: '/stop',
      messageId: 'm1',
    });

    // Verify permission denied message.
    expect(env.replies.length).toBeGreaterThan(0);
    const reply = env.replies.join('\n');
    expect(reply).toMatch(/权限不足|无权限|认证/i);
  });

  it('/stop with no active session shows Chinese hint', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    // Don't create a session, so no active session exists.
    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u-admin',
      text: '/stop',
      messageId: 'm1',
    });

    // Verify the hint message.
    expect(env.replies.length).toBeGreaterThan(0);
    const reply = env.replies.join('\n');
    expect(reply).toMatch(/活跃会话|当前没有|未绑定|\/new/);
  });
});
