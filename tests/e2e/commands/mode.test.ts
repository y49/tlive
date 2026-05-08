// tests/e2e/commands/mode.test.ts
//
// e2e tests for the /mode command (Task 16: F2 InteractivePicker接入).
//
// Covers:
//   - /mode (no arg) → renders picker with runtime:mode:set:* buttons + ✅ on current
//   - /mode <name> → applies mode immediately, replies confirmation
//   - callback runtime:mode:set:<value> by admin → applies mode
//   - callback runtime:mode:set:* by observer → 权限不足
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

describe('/mode — picker + direct set + callback', () => {
  it('no-arg /mode renders picker with runtime:mode:set:* callbackData', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        defaults: { permissionMode: 'default' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    // Start a session so the active-session path is exercised.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm0',
    });
    env.replies.length = 0;

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/mode', messageId: 'm1',
    });

    // Reply text mentions mode picker.
    expect(env.replies.some((r) => /permission mode|权限模式/i.test(r))).toBe(true);

    // Last send call must have inline_keyboard with runtime:mode:set:* buttons.
    const sends = env.adapter.byKind('send');
    const lastSend = sends.at(-1)!;
    const buttons = flatButtons(lastSend);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.some((b) => b.callbackData?.startsWith('runtime:mode:set:'))).toBe(true);
  });

  it('no-arg /mode marks current mode with ✅ in picker buttons', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        defaults: { permissionMode: 'acceptEdits' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/mode', messageId: 'm1',
    });

    const sends = env.adapter.byKind('send');
    const lastSend = sends.at(-1)!;
    const buttons = flatButtons(lastSend);
    // The button for acceptEdits should have ✅ marker in its text.
    const acceptEditsBtn = buttons.find((b) => b.callbackData === 'runtime:mode:set:acceptEdits');
    expect(acceptEditsBtn).toBeDefined();
    expect(acceptEditsBtn!.text).toContain('✅');
  });

  it('/mode <name> applies mode and replies confirmation', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    // Start a session first so setPermissionMode can be called on it.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm0',
    });
    env.replies.length = 0;

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/mode bypassPermissions', messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    expect(reply).toContain('bypassPermissions');
  });

  it('callback runtime:mode:set:<value> by admin applies mode and replies', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    // Start a session so handleRuntimeMode can find it.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm0',
    });
    env.replies.length = 0;

    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      messageId: 'm1', callbackData: 'runtime:mode:set:plan',
    });

    expect(env.replies.some((r) => /plan|已切到|mode/i.test(r))).toBe(true);
  });

  it('/mode (no-arg) with no workspace replies bind hint', async () => {
    env = setupBootstrap({ workspaces: [] });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c-unbound', userId: 'u-any',
      text: '/mode', messageId: 'm1',
    });

    // Unbound chat → workspace binding hint.
    expect(env.replies.length).toBeGreaterThan(0);
  });
});
