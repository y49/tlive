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
          thinking: 'collapsed', verbose: false, prewarmCache: false, threadPerSession: false,
        },
        roles: { 'u1': 'admin' },
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

  it('state D: bound + non-admin → read-only, no keyboard', async () => {
    const { ctx, replies, replyMarkups } = buildCtx({
      workspace: { id: 'w1', name: 'tlive', workdir: '/p/t', roles: {} },
      userId: 'u1',
    });
    await workspaceCmd.run(ctx, []);
    expect(replies[0]).toMatch(/只读|无法切换/);
    expect(replyMarkups[0]).toBeUndefined();
  });

  it('state C: shows current chat binding active session, not workspace level', async () => {
    const { ctx, replies } = buildCtx({
      workspace: {
        id: 'w1', name: 'tlive', workdir: '/p/t',
        defaults: {
          provider: 'claude', permissionMode: 'default', thinking: 'collapsed',
          verbose: false, prewarmCache: false, threadPerSession: false,
        },
        roles: { 'u1': 'admin' },
        bindings: [
          { channelType: 'telegram', chatId: 'c1', activeSessionId: 'sid-tg-aaaaaaaa' },
          { channelType: 'feishu', chatId: 'c2', activeSessionId: 'sid-fs-bbbbbbbb' },
        ],
      },
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
    });
    await workspaceCmd.run(ctx, []);
    expect(replies[0]).toMatch(/sid-tg-/);
    expect(replies[0]).not.toMatch(/sid-fs-/);
  });

  it('state C: shows "其他 chat" count when other bindings exist', async () => {
    const { ctx, replies } = buildCtx({
      workspace: {
        id: 'w1', name: 'tlive', workdir: '/p/t',
        defaults: {
          provider: 'claude', permissionMode: 'default', thinking: 'collapsed',
          verbose: false, prewarmCache: false, threadPerSession: false,
        },
        roles: { 'u1': 'admin' },
        bindings: [
          { channelType: 'telegram', chatId: 'c1', activeSessionId: null },
          { channelType: 'feishu', chatId: 'c2', activeSessionId: 'sid-fs' },
          { channelType: 'feishu', chatId: 'c3', activeSessionId: null },
        ],
      },
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
    });
    await workspaceCmd.run(ctx, []);
    expect(replies[0]).toMatch(/其他 chat 在此项目: 2 个/);
  });

  it('state C: omits "其他 chat" line when only one binding (self)', async () => {
    const { ctx, replies } = buildCtx({
      workspace: {
        id: 'w1', name: 'tlive', workdir: '/p/t',
        defaults: {
          provider: 'claude', permissionMode: 'default', thinking: 'collapsed',
          verbose: false, prewarmCache: false, threadPerSession: false,
        },
        roles: { 'u1': 'admin' },
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
          verbose: false, prewarmCache: false, threadPerSession: false,
        },
        roles: { 'u1': 'admin' },
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
