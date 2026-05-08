// tests/e2e/commands/help.test.ts
//
// e2e tests for the /help command.
//
// Covers:
//   - /help lists all 12 commands (/new /sessions /workspace /cost /find /stop /model /mode /think /perm /budget /help)
//   - /help includes per-chat isolation note (Iso v3.3)
//   - /help is available to all roles (admin, operator, observer)
//
// Uses setupBootstrap() so real command dispatch is exercised, including role gating.

import { describe, it, expect, afterEach } from 'vitest';
import { setupBootstrap, type BootstrapFixture } from '../../_helpers/bootstrap-fixture.js';

let env: BootstrapFixture | undefined;

afterEach(async () => {
  await env?.cleanup?.();
  env = undefined;
});

describe('/help — 12-command catalog + per-chat isolation note', () => {
  it('lists all 12 commands', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/tlive-e2e-help-1',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u-admin',
      text: '/help',
      messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    // Verify all 12 commands are listed.
    const commands = [
      '/new',
      '/sessions',
      '/workspace',
      '/cost',
      '/find',
      '/stop',
      '/model',
      '/mode',
      '/think',
      '/perm',
      '/budget',
      '/help',
    ];
    for (const cmd of commands) {
      expect(reply).toContain(cmd);
    }
  });

  it('mentions per-chat isolation (Iso v3.3)', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/tlive-e2e-help-2',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u-admin',
      text: '/help',
      messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    // Should mention per-chat isolation (Chinese phrasing: 各 chat 独立, per-chat, or 每个 chat).
    expect(reply).toMatch(/各\s*chat\s*独立|per-chat|每个\s*chat/i);
  });

  it('admin can /help', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/tlive-e2e-help-3',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u-admin',
      text: '/help',
      messageId: 'm1',
    });

    // Should NOT be denied.
    expect(env.replies.some((r) => /权限不足|无权限/.test(r))).toBe(false);
    // Should return help content.
    expect(env.replies.length).toBeGreaterThan(0);
    expect(env.replies.some((r) => /命令|help|帮助/i.test(r))).toBe(true);
  });

  it('operator can /help', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/tlive-e2e-help-4',
        roles: { 'u-op': 'operator' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u-op',
      text: '/help',
      messageId: 'm1',
    });

    // Should NOT be denied.
    expect(env.replies.some((r) => /权限不足|无权限/.test(r))).toBe(false);
    // Should return help content.
    expect(env.replies.length).toBeGreaterThan(0);
  });

  it('observer can /help', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/tlive-e2e-help-5',
        defaultRole: 'observer',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u-anon',
      text: '/help',
      messageId: 'm1',
    });

    // Should NOT be denied.
    expect(env.replies.some((r) => /权限不足|无权限/.test(r))).toBe(false);
    // Should return help content.
    expect(env.replies.length).toBeGreaterThan(0);
    expect(env.replies.some((r) => /命令|help|帮助/i.test(r))).toBe(true);
  });
});
