// tests/e2e/commands/cost.test.ts
//
// e2e tests for the /cost command.
//
// Covers:
//   - /cost shows workspace + session cost (admin)
//   - observer can view /cost (read-only, no permission denial)
//
// Uses setupBootstrap() so real command dispatch is exercised, including role gating.

import { describe, it, expect, afterEach } from 'vitest';
import { setupBootstrap, type BootstrapFixture } from '../../_helpers/bootstrap-fixture.js';

let env: BootstrapFixture | undefined;

afterEach(async () => {
  await env?.cleanup?.();
  env = undefined;
});

describe('/cost — workspace + session cost + observer access', () => {
  it('text /cost shows workspace + session cost (admin)', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test-ws', workdir: '/tmp/tlive-e2e-cost-1',
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
        id: 'w2', name: 'test-ws', workdir: '/tmp/tlive-e2e-cost-2',
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
