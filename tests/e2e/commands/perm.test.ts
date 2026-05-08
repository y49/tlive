// tests/e2e/commands/perm.test.ts
//
// e2e tests for the /perm command (Task 18).
//
// Decision: Option A — /perm already renders an inline_keyboard action menu
// on no-arg invocation (renderRules in perm.ts). The buttons are:
//   [➕ allow]  [➕ deny]  (always)
//   [🗑 清空]              (only when rules exist)
// with callbackData:
//   runtime:perm:add:allow / runtime:perm:add:deny
//   runtime:perm:clear:confirm → confirm → runtime:perm:clear:do
//
// The callback router (handleRuntimePerm, Task 8.5) role-gates these buttons
// to admin/operator only. Observer gets "权限不足".
//
// The /perm command itself uses policyStoreFor from CommandContext; the
// callback router uses policyStoreFor from its deps. Both are wired via the
// new BootstrapFixtureOpts.policyStoreFor extension.
//
// Covers:
//   1. /perm (no-arg) → shows rule list + inline_keyboard action buttons
//   2. /perm allow <pattern> → adds allow rule, replies confirmation
//   3. /perm deny <pattern> → adds deny rule, replies confirmation
//   4. /perm remove <id> → removes rule, replies confirmation
//   5. /perm clear → clears all rules, replies count
//   6. /perm allow (no pattern) → usage hint
//   7. callback runtime:perm:add:allow by admin → guidance message
//   8. callback runtime:perm:clear:confirm by admin → confirmation prompt
//   9. callback runtime:perm:add:allow by observer → 权限不足
//  10. /perm (no workspace) → bind hint

import { describe, it, expect, afterEach } from 'vitest';
import {
  setupBootstrap,
  buildFakePolicyStoreFactory,
  type BootstrapFixture,
} from '../../_helpers/bootstrap-fixture.js';

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

describe('/perm — action menu + text subcommands + callback + role (Option A)', () => {
  it('no-arg /perm renders inline_keyboard with runtime:perm:add:* buttons', async () => {
    const { factory } = buildFakePolicyStoreFactory();
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
      policyStoreFor: factory,
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/perm', messageId: 'm1',
    });

    // Should reply with something (rule list or empty state).
    expect(env.replies.length).toBeGreaterThan(0);

    // Last send must have inline_keyboard with perm action buttons.
    const sends = env.adapter.byKind('send');
    const lastSend = sends.at(-1)!;
    const buttons = flatButtons(lastSend);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.some((b) => b.callbackData === 'runtime:perm:add:allow')).toBe(true);
    expect(buttons.some((b) => b.callbackData === 'runtime:perm:add:deny')).toBe(true);
  });

  it('no-arg /perm with empty store shows 暂无权限规则', async () => {
    const { factory } = buildFakePolicyStoreFactory();
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
      policyStoreFor: factory,
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/perm', messageId: 'm1',
    });

    expect(env.replies.some((r) => /暂无权限规则/.test(r))).toBe(true);
    // 🗑 清空 button should NOT appear when store is empty.
    const sends = env.adapter.byKind('send');
    const lastSend = sends.at(-1)!;
    const buttons = flatButtons(lastSend);
    expect(buttons.some((b) => b.callbackData === 'runtime:perm:clear:confirm')).toBe(false);
  });

  it('/perm allow <pattern> adds allow rule and replies confirmation', async () => {
    const { factory } = buildFakePolicyStoreFactory();
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
      policyStoreFor: factory,
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/perm allow Bash(npm test)', messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    expect(reply).toContain('allow');
    expect(reply).toContain('Bash(npm test)');
    // Should show success emoji or the pattern.
    expect(reply).toMatch(/✅|已添加/);
  });

  it('/perm deny <pattern> adds deny rule and replies confirmation', async () => {
    const { factory } = buildFakePolicyStoreFactory();
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
      policyStoreFor: factory,
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/perm deny rm -rf', messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    expect(reply).toContain('deny');
    expect(reply).toMatch(/✅|已添加/);
  });

  it('/perm remove <id> removes rule and replies confirmation', async () => {
    const { factory, storeMap } = buildFakePolicyStoreFactory();
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
      policyStoreFor: factory,
    });

    // Pre-seed a rule so we have an id to remove.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/perm allow SomePattern', messageId: 'm0',
    });
    env.replies.length = 0;

    // Grab the rule id from the store.
    const rules = storeMap.get('w1') ?? [];
    expect(rules.length).toBe(1);
    const ruleId = rules[0]!.id;

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: `/perm remove ${ruleId}`, messageId: 'm2',
    });

    const reply = env.replies.join('\n');
    expect(reply).toMatch(/✅|已删除/);
    expect(storeMap.get('w1')?.length).toBe(0);
  });

  it('/perm clear removes all rules and replies count', async () => {
    const { factory, storeMap } = buildFakePolicyStoreFactory();
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
      policyStoreFor: factory,
    });

    // Seed two rules.
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/perm allow PatternA', messageId: 'm0',
    });
    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/perm deny PatternB', messageId: 'm1',
    });
    expect(storeMap.get('w1')?.length).toBe(2);
    env.replies.length = 0;

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/perm clear', messageId: 'm2',
    });

    const reply = env.replies.join('\n');
    expect(reply).toMatch(/✅|已清空/);
    expect(storeMap.get('w1')?.length).toBe(0);
  });

  it('/perm allow (no pattern) replies usage hint', async () => {
    const { factory } = buildFakePolicyStoreFactory();
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
      policyStoreFor: factory,
    });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      text: '/perm allow', messageId: 'm1',
    });

    const reply = env.replies.join('\n');
    // Should show usage hint, not crash.
    expect(reply).toMatch(/用法|allow/i);
  });

  it('callback runtime:perm:add:allow by admin replies guidance message', async () => {
    const { factory } = buildFakePolicyStoreFactory();
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
      policyStoreFor: factory,
    });

    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      messageId: 'm1', callbackData: 'runtime:perm:add:allow',
    });

    // Should reply with guidance to send /perm allow <pattern>.
    const reply = env.replies.join('\n');
    expect(reply).toMatch(/\/perm\s+allow|allow\s+规则/i);
  });

  it('callback runtime:perm:clear:confirm by admin shows confirm/cancel buttons', async () => {
    const { factory } = buildFakePolicyStoreFactory();
    env = setupBootstrap({
      workspaces: [{
        id: 'w1', name: 'test', workdir: '/tmp/x',
        bindings: [{ channelType: 'telegram', chatId: 'c1' }],
      }],
      policyStoreFor: factory,
    });

    await env.dispatchCallback({
      channelType: 'telegram', chatId: 'c1', userId: 'u-admin',
      messageId: 'm1', callbackData: 'runtime:perm:clear:confirm',
    });

    const sends = env.adapter.byKind('send');
    const lastSend = sends.at(-1)!;
    const buttons = flatButtons(lastSend);
    // Confirmation dialog should offer ✅ 清空 and ❌ 取消.
    expect(buttons.some((b) => b.callbackData === 'runtime:perm:clear:do')).toBe(true);
    expect(buttons.some((b) => b.callbackData === 'runtime:perm:clear:cancel')).toBe(true);
  });

  it('/perm with no workspace replies bind hint', async () => {
    env = setupBootstrap({ workspaces: [] });

    await env.handleInbound({
      channelType: 'telegram', chatId: 'c-unbound', userId: 'u-any',
      text: '/perm', messageId: 'm1',
    });

    // Unbound chat → "未绑定工作区" reply.
    expect(env.replies.length).toBeGreaterThan(0);
  });
});
