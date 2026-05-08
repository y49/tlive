// tests/e2e/commands/workspace.test.ts
//
// e2e tests for the /workspace command — 4-state UX.
//
// Per spec §4 / Iso §6.2:
//   State A: unbound chat, no workspaces     → [➕ 新增工作区] prompt only
//   State B: unbound chat, has workspaces    → lists workspace names for binding
//   State C: bound + admin                  → workspace info + optional session +
//                                              multi-chat counter + action buttons
//   State D: bound + non-admin (observer)   → read-only view
//
// Uses setupBootstrap() — real command dispatch + real CallbackRouter.
// No daemon or real session runtimes are spun up.
//
// Note on replies vs adapter.send calls:
//   The fixture's replyFn pushes message text to env.replies AND calls
//   adapter.send(). The inline-keyboard button labels live in replyMarkup
//   (captured by adapter.byKind('send')), NOT in the message text. So:
//   - Check workspace names / "新增" labels via adapter.send().replyMarkup.buttons
//   - Check state lines (session, multi-chat counter) via env.replies

import { describe, it, expect, afterEach } from 'vitest';
import { setupBootstrap, type BootstrapFixture } from '../../_helpers/bootstrap-fixture.js';

/** Flatten all button objects from a send-call's replyMarkup. */
function flatButtons(
  call: { args: Record<string, unknown> },
): Array<{ text: string; callbackData: string }> {
  const rm = call.args.replyMarkup as
    | { buttons?: Array<Array<{ text: string; callbackData: string }>> }
    | undefined;
  return rm?.buttons?.flat() ?? [];
}

let env: BootstrapFixture | undefined;

afterEach(async () => {
  await env?.cleanup?.();
  env = undefined;
});

describe('/workspace — 4 state UX', () => {
  it('state A (unbound + no ws) prompts to create a new workspace', async () => {
    env = setupBootstrap({ workspaces: [] });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'cNew', userId: 'u-admin',
      text: '/workspace', messageId: 'm1',
    });

    // State A: message text mentions "no workspaces".
    const reply = env.replies.join('\n');
    expect(reply).toMatch(/还没进入工作区|系统暂无/);

    // The [➕ 新增工作区] label must appear in the inline keyboard buttons.
    const sendCalls = env.adapter.byKind('send');
    const allButtons = sendCalls.flatMap(flatButtons);
    expect(allButtons.some((b) => /新增/.test(b.text))).toBe(true);
    // Callback data for the new-workspace button.
    expect(allButtons.some((b) => b.callbackData === 'workspace:create:start')).toBe(true);
  });

  it('state B (unbound + has ws) lists workspaces for binding', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'my-proj', workdir: '/tmp/tlive-e2e-ws-b',
        bindings: [],
      }],
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'cNew', userId: 'u-any',
      text: '/workspace', messageId: 'm1',
    });

    // State B: message text says the chat is not yet bound.
    const reply = env.replies.join('\n');
    expect(reply).toMatch(/还没进入工作区|可用工作区/);

    // The workspace name must appear as a button label.
    const sendCalls = env.adapter.byKind('send');
    const allButtons = sendCalls.flatMap(flatButtons);
    expect(allButtons.some((b) => b.text.includes('my-proj'))).toBe(true);
    // Callback data must include workspace:bind:<id>.
    expect(allButtons.some((b) => b.callbackData === 'workspace:bind:w1')).toBe(true);
  });

  it('state C (bound + admin, no active session) shows workspace info with action buttons', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'proj', workdir: '/tmp/tlive-e2e-ws-c',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/workspace', messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    // Must show workspace name and workdir.
    expect(reply).toContain('proj');
    expect(reply).toContain('/tmp/tlive-e2e-ws-c');
    // No active session → session line must NOT appear.
    expect(reply).not.toMatch(/此 chat 的会话/);

    // Action buttons: at minimum exit must be present.
    const sendCalls = env.adapter.byKind('send');
    const allButtons = sendCalls.flatMap(flatButtons);
    expect(allButtons.some((b) => b.callbackData === 'workspace:exit:confirm')).toBe(true);
  });

  it('state C with active session in current chat shows session reference', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'proj', workdir: '/tmp/tlive-e2e-ws-c-sess',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
    });

    // Create a session for this chat (binds activeSessionId on the binding).
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/new', messageId: 'm0',
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/workspace', messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    expect(reply).toContain('proj');
    // Session line format: "💬 此 chat 的会话: <id-prefix>"
    expect(reply).toMatch(/此 chat 的会话/);
  });

  it('state C with multi-chat bindings shows "其他 chat" counter', async () => {
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'proj', workdir: '/tmp/tlive-e2e-ws-multi',
        bindings: [
          { channelType: 'telegram', chatId: 'c1' },
          { channelType: 'feishu',   chatId: 'cF' },
        ],
      }],
    });

    env.replies.length = 0;
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/workspace', messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    // Format: "👥 其他 chat 在此项目: 1 个(各自独立)"
    expect(reply).toMatch(/其他 chat.*1/);
  });
});
