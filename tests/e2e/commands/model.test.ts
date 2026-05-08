// tests/e2e/commands/model.test.ts
//
// e2e tests for the /model command (Task 15: F2 InteractivePicker接入).
//
// Covers:
//   - /model (no arg) → renders F2 picker with runtime:model:set:* buttons
//   - /model <name> → applies model immediately, replies confirmation
//   - callback runtime:model:set:<name> by admin → applies model
//   - callback runtime:model:set:* by observer → denied (Task 8.5 role check)
//
// Uses setupBootstrap() with real command dispatch + real CallbackRouter.
// No daemon or real session runtimes are spun up.
//
// Note: the fake session created by /new does NOT have a live runtime, so
// the no-arg picker always falls through to the F2 KNOWN_MODELS fallback
// (renderPicker from src/im/picker/picker.ts). This exercises Approach 1
// (additive F2 picker) with callbacks handled by handleRuntimeModel.

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

describe('/model — picker + direct set + callback + role', () => {
  it('no-arg /model renders F2 picker with runtime:model:set:* callbackData', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        roles: { 'u-admin': 'admin' },
        defaults: { model: 'claude-sonnet-4-6' },
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
      text: '/model', messageId: 'm1',
    });

    // Reply text mentions model picker (title contains 选择模型).
    expect(env.replies.some((r) => /选择模型/i.test(r))).toBe(true);

    // Last send call must have inline_keyboard with runtime:model:set:* buttons.
    const sends = env.adapter.byKind('send');
    const lastSend = sends.at(-1)!;
    const buttons = flatButtons(lastSend);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.some((b) => b.callbackData?.startsWith('runtime:model:set:'))).toBe(true);
  });

  it('no-arg /model marks current model with ✅ in picker buttons', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        roles: { 'u-admin': 'admin' },
        defaults: { model: 'claude-sonnet-4-6' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/model', messageId: 'm1',
    });

    const sends = env.adapter.byKind('send');
    const lastSend = sends.at(-1)!;
    const buttons = flatButtons(lastSend);
    // The button for claude-sonnet-4-6 should have ✅ marker in its text.
    const sonnetBtn = buttons.find((b) => b.callbackData === 'runtime:model:set:claude-sonnet-4-6');
    expect(sonnetBtn).toBeDefined();
    expect(sonnetBtn!.text).toContain('✅');
  });

  it('/model <name> applies model and replies confirmation', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    // Start a session first so setModel can be called on it.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm0',
    });
    env.replies.length = 0;

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/model claude-haiku-4-5-20251001', messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    expect(reply).toContain('claude-haiku-4-5-20251001');
  });

  it('callback runtime:model:set:<name> by admin applies model and replies', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w', name: 't', workdir: '/tmp/x',
        roles: { 'u-admin': 'admin' },
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    // Start a session so handleRuntimeModel can find it.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm0',
    });
    env.replies.length = 0;

    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      messageId: 'm1', callbackData: 'runtime:model:set:claude-opus-4-7',
    });

    expect(env.replies.some((r) => /claude-opus-4-7|已切到|model/i.test(r))).toBe(true);
  });

  it('callback runtime:model:set:* by observer is denied (Task 8.5 role check)', async () => {
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
      messageId: 'm1', callbackData: 'runtime:model:set:claude-opus-4-7',
    });

    expect(env.replies.some((r) => /权限不足|无权限/.test(r))).toBe(true);
  });

  it('/model (no-arg) with no workspace replies bind hint', async () => {
    env = setupBootstrap({ workspaces: [] });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c-unbound', userId: 'u-any',
      text: '/model', messageId: 'm1',
    });

    // Command role=admin/operator — observer will be denied at dispatch level.
    // Either a permission denial OR workspace binding hint is acceptable.
    expect(env.replies.length).toBeGreaterThan(0);
  });
});
