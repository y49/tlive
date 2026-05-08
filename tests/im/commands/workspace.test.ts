import { describe, it, expect } from 'vitest';
import { workspaceCmd } from '../../../src/im/commands/workspace.js';
import { buildCtx } from './_helpers.js';

describe('/workspace state-adaptive', () => {
  it('state A: unbound chat, has other workspaces → list + [➕] button', async () => {
    const { ctx, replies, replyMarkups } = buildCtx({
      workspace: null,
      otherWorkspaces: [
        { id: 'w1', name: 'tlive', workdir: '/p/t' },
        { id: 'w2', name: 'api', workdir: '/p/a' },
      ],
    });
    await workspaceCmd.run(ctx, []);
    expect(replies[0]).toMatch(/还没进入工作区/);
    const labels = (replyMarkups[0]!.buttons!).flat().map((b) => b.text);
    expect(labels.some((l) => l.includes('tlive'))).toBe(true);
    expect(labels.some((l) => l.includes('api'))).toBe(true);
    expect(labels.some((l) => l.includes('新增工作区'))).toBe(true);
  });

  it('state B: unbound chat + no workspaces → only [➕]', async () => {
    const { ctx, replies, replyMarkups } = buildCtx({ workspace: null, otherWorkspaces: [] });
    await workspaceCmd.run(ctx, []);
    expect(replies[0]).toMatch(/暂无任何工作区/);
    const labels = (replyMarkups[0]!.buttons!).flat().map((b) => b.text);
    expect(labels).toContain('➕ 新增工作区');
    expect(labels).toHaveLength(1);
  });

  it('state C: bound + admin → status + switch + manage buttons', async () => {
    const { ctx, replies, replyMarkups } = buildCtx({
      workspace: {
        id: 'w1', name: 'tlive', workdir: '/p/t',
        defaults: {
          provider: 'claude', model: 'claude-sonnet-4-6', permissionMode: 'default',
          thinking: 'collapsed',
        },
      },
      userId: 'u1',
      otherWorkspaces: [{ id: 'w2', name: 'api', workdir: '/p/a' }],
    });
    await workspaceCmd.run(ctx, []);
    expect(replies[0]).toMatch(/当前工作区.*tlive/);
    expect(replies[0]).toMatch(/claude-sonnet-4-6/);
    const labels = (replyMarkups[0]!.buttons!).flat().map((b) => b.text);
    expect(labels.some((l) => l.includes('api'))).toBe(true);
    expect(labels).toContain('📤 退出工作区');
    expect(labels).toContain('➕ 新增工作区');
    expect(labels).toContain('⚙ 配置');
  });

  it('state C: chat-trust — any user sees bound state (no read-only state D)', async () => {
    // chat-trust model: state D (read-only for observer) no longer exists.
    // Any user in a bound chat sees the full bound state with keyboard.
    const { ctx, replies, replyMarkups } = buildCtx({
      workspace: { id: 'w1', name: 'tlive', workdir: '/p/t' },
      userId: 'u-anon',
    });
    await workspaceCmd.run(ctx, []);
    expect(replies[0]).toMatch(/当前工作区/);
    expect(replyMarkups[0]).toBeDefined();
    expect(replyMarkups[0]!.buttons).toBeDefined();
  });

  it('state C: shows current chat binding active session, not other-chat session', async () => {
    // Use activeSessionId at workspace level (legacy compat in buildCtx)
    const { ctx, replies } = buildCtx({
      workspace: {
        id: 'w1', name: 'tlive', workdir: '/p/t',
        defaults: {
          provider: 'claude', permissionMode: 'default', thinking: 'collapsed',
        },
        // seed activeSessionId via legacy field (buildCtx reads wsAny.activeSessionId)
        activeSessionId: 'sid-tg-aaaaaaaa',
      },
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
    });
    await workspaceCmd.run(ctx, []);
    expect(replies[0]).toMatch(/sid-tg-/);
  });

  it('state C: shows "其他 chat" count when other ChatInstances exist for same workspace', async () => {
    const { ctx, replies } = buildCtx({
      workspace: {
        id: 'w1', name: 'tlive', workdir: '/p/t',
        defaults: {
          provider: 'claude', permissionMode: 'default', thinking: 'collapsed',
        },
      },
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
    });
    // Add two more ChatInstances for the same workspace (same workspaceId)
    const wm = ctx.workspaceManager;
    // These will be the "other chats" — feishu c2 and feishu c3
    // Since the fake WM doesn't validate workspace existence, inject them directly
    const inst2 = { channelType: 'feishu' as const, chatId: 'c2', workspaceId: 'w1', activeSessionId: 'sid-fs', lastActiveAt: null, costRollup: { totalUsd: 0, sessionCount: 0, lastResetAt: '' }, createdAt: '' };
    const inst3 = { channelType: 'feishu' as const, chatId: 'c3', workspaceId: 'w1', activeSessionId: null, lastActiveAt: null, costRollup: { totalUsd: 0, sessionCount: 0, lastResetAt: '' }, createdAt: '' };
    // Use bindChat to add them to the fake WM
    (wm as any).bindChat({ workspaceId: 'w1', channelType: 'feishu', chatId: 'c2' });
    (wm as any).bindChat({ workspaceId: 'w1', channelType: 'feishu', chatId: 'c3' });
    void inst2; void inst3; // silence unused warning
    await workspaceCmd.run(ctx, []);
    expect(replies[0]).toMatch(/其他 chat 在此项目: 2 个/);
  });

  it('state C: omits "其他 chat" line when only one binding (self)', async () => {
    const { ctx, replies } = buildCtx({
      workspace: {
        id: 'w1', name: 'tlive', workdir: '/p/t',
        defaults: {
          provider: 'claude', permissionMode: 'default', thinking: 'collapsed',
        },
        // Helper seeds a single binding for the inbound chat by default.
      },
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
    });
    await workspaceCmd.run(ctx, []);
    expect(replies[0]).not.toMatch(/其他 chat 在此项目/);
  });

  it('state C with no other workspaces: only management row, no switch row', async () => {
    const { ctx, replyMarkups } = buildCtx({
      workspace: {
        id: 'w1', name: 'tlive', workdir: '/p/t',
        defaults: {
          provider: 'claude', permissionMode: 'default', thinking: 'collapsed',
        },
      },
      userId: 'u1',
      otherWorkspaces: [],
    });
    await workspaceCmd.run(ctx, []);
    const labels = (replyMarkups[0]!.buttons!).flat().map((b) => b.text);
    // No '📁 X' switch button
    expect(labels.filter((l) => l.startsWith('📁')).length).toBe(0);
    expect(labels).toContain('➕ 新增工作区');
  });
});
