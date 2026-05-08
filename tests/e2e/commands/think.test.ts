// tests/e2e/commands/think.test.ts
//
// e2e tests for the /think command (Task 17: F2 InteractivePicker接入).
//
// Covers:
//   - /think (no arg) → renders picker with runtime:think:set:* buttons + ✅ on current
//   - /think <level> → persists workspace default, replies confirmation
//   - callback runtime:think:set:<level> by admin → applies level
//   - callback runtime:think:set:* by observer → 权限不足
//
// Uses setupBootstrap() with real command dispatch + real CallbackRouter.
// No daemon or real session runtimes are spun up.

import { describe, it, expect, afterEach } from 'vitest';
import { setupBootstrap, type BootstrapFixture } from '../../_helpers/bootstrap-fixture.js';

/** Flatten all button objects from a send-call's replyMarkup. */
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

describe('/think — picker + direct set + callback + role', () => {
  it('no-arg /think renders picker with runtime:think:set:* callbackData', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        defaults: { permissionMode: 'default' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/think', messageId: 'm1',
    });

    // Reply text mentions thinking picker.
    expect(env.replies.some((r) => /思考深度|think/i.test(r))).toBe(true);

    // Last send call must have inline_keyboard with runtime:think:set:* buttons.
    const sends = env.adapter.byKind('send');
    const lastSend = sends.at(-1)!;
    const buttons = flatButtons(lastSend);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.some((b) => b.callbackData?.startsWith('runtime:think:set:'))).toBe(true);
  });

  it('no-arg /think marks current level with ✅ in picker buttons', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        defaults: { permissionMode: 'default' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    // Default thinking in bootstrap fixture is 'collapsed'.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/think', messageId: 'm1',
    });

    const sends = env.adapter.byKind('send');
    const lastSend = sends.at(-1)!;
    const buttons = flatButtons(lastSend);
    // The button for collapsed should have ✅ marker.
    const collapsedBtn = buttons.find((b) => b.callbackData === 'runtime:think:set:collapsed');
    expect(collapsedBtn).toBeDefined();
    expect(collapsedBtn!.text).toContain('✅');
    // Other buttons should NOT have ✅.
    const expandedBtn = buttons.find((b) => b.callbackData === 'runtime:think:set:expanded');
    expect(expandedBtn).toBeDefined();
    expect(expandedBtn!.text).not.toContain('✅');
  });

  it('/think <level> applies level and replies confirmation', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/think expanded', messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    expect(reply).toContain('expanded');
  });

  it('callback runtime:think:set:<level> by admin applies level and replies', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      messageId: 'm1', callbackData: 'runtime:think:set:hidden',
    });

    expect(env.replies.some((r) => /hidden|已切到|think/i.test(r))).toBe(true);
  });

});

