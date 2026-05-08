// tests/e2e/commands/cost.test.ts
//
// e2e tests for the /cost command.
//
// Covers:
//   - /cost 默认显示当前 chat costRollup (ChatInstance.costRollup)
//   - /cost --workspace 跨 chat 同 ws 总和
//   - /cost --all 列所有 ws 的 chatInstance 总和
//   - /cost shows workspace + session cost (basic smoke)
//   - any user may view /cost (chat-trust, no permission denial)
//
// Uses setupBootstrap() so real command dispatch is exercised.

import { describe, it, expect, afterEach } from 'vitest';
import { setupBootstrap, type BootstrapFixture } from '../../_helpers/bootstrap-fixture.js';

let env: BootstrapFixture | undefined;

afterEach(async () => {
  await env?.cleanup?.();
  env = undefined;
});

describe('/cost — per-chat costRollup + scope flags', () => {
  it('/cost 默认显示当前 chat costRollup', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test-ws', workdir: '/tmp/tlive-e2e-cost-new-1',
        bindings: [{ channelType: 'telegram', chatId: 'tg-1' }],
      }],
    });

    // Simulate two sessions ended at $0.5 each via addCost(sessionEnded=true)
    env.workspaceManager.addCost('telegram', 'tg-1', 0.5, true);
    env.workspaceManager.addCost('telegram', 'tg-1', 0.5, true);

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram', chatId: 'tg-1', userId: 'u1',
      text: '/cost', messageId: 'm-cost-1',
    });

    const text = env.replies.join('\n');
    expect(text).toMatch(/此 chat.*\$1\.0/);
    expect(text).toMatch(/2 sessions/);
  });

  it('/cost --workspace 跨 chat 同 ws 总和', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w2', name: 'test-ws', workdir: '/tmp/tlive-e2e-cost-new-2',
        bindings: [{ channelType: 'telegram', chatId: 'tg-1' }],
      }],
    });

    // Bind a second chat (feishu) to the same workspace
    env.workspaceManager.bindChat({ workspaceId: 'w2', channelType: 'feishu', chatId: 'fs-x' });

    env.workspaceManager.addCost('telegram', 'tg-1', 1.0, true);
    env.workspaceManager.addCost('feishu', 'fs-x', 0.5, true);

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram', chatId: 'tg-1', userId: 'u1',
      text: '/cost --workspace', messageId: 'm-cost-ws',
    });

    const text = env.replies.join('\n');
    expect(text).toMatch(/合计.*\$1\.5/);
    expect(text).toMatch(/chat tg-1/);
    expect(text).toMatch(/chat fs-x/);
  });

  it('/cost --all 列所有 ws 的 chatInstance', async () => {
    env = setupBootstrap({
      workspaces: [
        {
          id: 'w3a', name: 'ws-a', workdir: '/tmp/tlive-e2e-cost-new-3a',
          bindings: [{ channelType: 'telegram', chatId: 'tg-1' }],
        },
        {
          id: 'w3b', name: 'ws-b', workdir: '/tmp/tlive-e2e-cost-new-3b',
          bindings: [{ channelType: 'feishu', chatId: 'fs-y' }],
        },
      ],
    });

    env.workspaceManager.addCost('telegram', 'tg-1', 0.3, true);
    env.workspaceManager.addCost('feishu', 'fs-y', 0.7, true);

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram', chatId: 'tg-1', userId: 'u1',
      text: '/cost --all', messageId: 'm-cost-all',
    });

    const text = env.replies.join('\n');
    expect(text).toMatch(/全部.*\$1\.0/);
  });
});

describe('/cost — basic smoke + chat-trust', () => {
  it('text /cost shows workspace + session cost (admin)', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w4', name: 'test-ws', workdir: '/tmp/tlive-e2e-cost-1',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    // Create a session to have something to report on.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm-new',
    });

    // Clear previous replies and query /cost.
    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/cost', messageId: 'm-cost',
    });

    const reply = env.replies.join('\n');
    // Should contain cost symbol and values.
    expect(reply).toMatch(/💰/);
    expect(reply).toMatch(/\$/);
    // Should mention workspace or session count.
    expect(reply.length).toBeGreaterThan(0);
  });

  it('observer can /cost (read-only) without permission denial', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w5', name: 'test-ws', workdir: '/tmp/tlive-e2e-cost-2',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-anon',
      text: '/cost', messageId: 'm-cost-obs',
    });

    // Should NOT reply with permission denial.
    expect(env.replies.some((r) => /权限不足|无权限/.test(r))).toBe(false);
    // Should reply with cost information.
    expect(env.replies.length).toBeGreaterThan(0);
    expect(env.replies.some((r) => /💰/.test(r))).toBe(true);
  });
});
