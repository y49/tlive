// tests/e2e/commands/budget.test.ts
//
// e2e tests for the /budget command (Task 19: preset picker + role gate).
//
// Covers:
//   - /budget (no-arg, active session) → shows status + preset picker buttons
//   - /budget <usd>  → applies cap immediately, replies confirmation
//   - /budget unlimited → clears cap, replies confirmation
//   - callback runtime:budget:set:5 by admin → applies cap
//   - callback runtime:budget:set:* by observer → denied (role check)
//   - /budget (no active session) → replies "无活跃会话"
//
// Note: custom amounts use the text path `/budget <usd>`;
//       the `runtime:budget:custom` stub was removed in favour of preset buttons.
//
// Uses setupBootstrap() — no daemon or real session runtime.

import { describe, it, expect, afterEach } from 'vitest';
import { setupBootstrap, type BootstrapFixture } from '../../_helpers/bootstrap-fixture.js';

/** Flatten all button objects from the last send-call's replyMarkup. */
function flatButtons(
  call: { args: Record<string, unknown> },
): Array<{ text: string; callbackData?: string }> {
  const rm = call.args.replyMarkup as
    | { buttons?: Array<Array<{ text: string; callbackData?: string }>> }
    | undefined;
  return rm?.buttons?.flat() ?? [];
}

let env: BootstrapFixture | undefined;

afterEach(async () => {
  await env?.cleanup?.();
  env = undefined;
});

describe('/budget — preset picker + direct set + callback + role', () => {
  it('no-arg /budget with active session shows status + preset picker', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    // Start session so activeLocalSession succeeds.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm0',
    });
    env.replies.length = 0;

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/budget', messageId: 'm1',
    });

    // Reply mentions budget status.
    expect(env.replies.some((r) => /预算|budget/i.test(r))).toBe(true);

    // Last send must carry inline_keyboard with runtime:budget:set:* buttons.
    const sends = env.adapter.byKind('send');
    const lastSend = sends.at(-1)!;
    const buttons = flatButtons(lastSend);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.some((b) => b.callbackData?.startsWith('runtime:budget:set:'))).toBe(true);
    // Preset amounts are present.
    const cbs = buttons.map((b) => b.callbackData ?? '');
    expect(cbs).toContain('runtime:budget:set:1');
    expect(cbs).toContain('runtime:budget:set:100');
    expect(cbs).toContain('runtime:budget:set:unlimited');
    // Custom stub is NOT present (Option B — preset only).
    expect(cbs.includes('runtime:budget:custom')).toBe(false);
  });

  it('/budget <usd> applies cap and replies confirmation', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm0',
    });
    env.replies.length = 0;

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/budget 42', messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    expect(reply).toContain('42');
    expect(reply).toMatch(/预算|budget/i);
  });

  it('/budget unlimited clears cap and replies confirmation', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm0',
    });
    env.replies.length = 0;

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/budget unlimited', messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    expect(reply).toMatch(/无限|unlimited/i);
  });

  it('callback runtime:budget:set:5 by admin applies cap and replies', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    // Start session so handleRuntimeBudget can find it.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm0',
    });
    env.replies.length = 0;

    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      messageId: 'm1', callbackData: 'runtime:budget:set:5',
    });

    const reply = env.replies.join('\n');
    // Should confirm budget was set (contains "5" or "预算").
    expect(reply).toMatch(/5|预算/);
    expect(env.replies.some((r) => /💸|预算/.test(r))).toBe(true);
  });

  it('callback runtime:budget:set:* by observer is denied', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        defaultRole: 'observer',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });
    env.replies.length = 0;

    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-anon',
      messageId: 'm1', callbackData: 'runtime:budget:set:20',
    });

    expect(env.replies.some((r) => /权限不足|无权限/.test(r))).toBe(true);
  });

  it('/budget with no active session replies usage hint', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        roles: { 'u-admin': 'admin' },
        // No activeSessionId set — binding has no active session.
        bindings: [{ channelType: 'telegram', chatId: 'c1', activeSessionId: null }],
      }],
    });
    env.replies.length = 0;

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/budget', messageId: 'm1',
    });

    // With no active session, command should explain the situation.
    expect(env.replies.length).toBeGreaterThan(0);
    expect(env.replies.some((r) => /会话|session|new/i.test(r))).toBe(true);
  });
});
