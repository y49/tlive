import { describe, it, expect } from 'vitest';
import { sessionsCmd } from '../../../src/im/commands/sessions.js';
import { buildCtx } from './_helpers.js';

describe('/sessions', () => {
  it('default scope: shows empty card with 🆕 新会话 button when chat has no sessions', async () => {
    const { ctx, replies, replyMarkups } = buildCtx();
    await sessionsCmd.run(ctx, []);
    expect(replies[0]).toContain('暂无会话');
    expect(replies[0]).toContain('当前 chat');
    const buttons = (replyMarkups[0]!.buttons!).flat();
    expect(buttons[0]?.text).toBe('🆕 新会话');
    expect(buttons[0]?.callbackData).toBe('session:new');
  });

  it('default scope: filters out sessions from other chats (ownerChat)', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: {
        id: 'sess-0001-0001-0001-0001',
        shortAlias: 'sess0001',
        title: 'other-chat-session',
        // Owned by a different chat — must be filtered out under per-chat scope.
        ownerChat: { channelType: 'feishu', chatId: 'other-c1' },
      } as never,
    });
    await sessionsCmd.run(ctx, []);
    expect(replies[0]).toContain('暂无会话');
    expect(replies[0]).not.toContain('sess0001');
  });

  it('default scope: same workspace, different chat → filtered out', async () => {
    const { ctx, replies } = buildCtx({
      // Same workspace as the inbound chat, but ownerChat is a different chat.
      activeSession: {
        id: 'sess-aaaa-aaaa-aaaa-aaaa',
        shortAlias: 'aaaaaaaa',
        title: 'sibling-chat',
        ownerChat: { channelType: 'telegram', chatId: 'different-chat' },
      } as never,
    });
    await sessionsCmd.run(ctx, []);
    expect(replies[0]).toContain('暂无会话');
    expect(replies[0]).not.toContain('aaaaaaaa');
  });

  it('default scope: lists ws-local sessions with row buttons + new button', async () => {
    const { ctx, replies, replyMarkups } = buildCtx({
      activeSession: {
        id: 'sess-0000-0000-0000-0000',
        shortAlias: 'abcd1234',
        title: 'demo',
      } as never,
    });
    await sessionsCmd.run(ctx, []);
    expect(replies[0]).toContain('abcd1234');
    expect(replies[0]).toContain('demo');
    const rows = replyMarkups[0]!.buttons!;
    // First row → resume + details, last row → new
    const firstRow = rows[0]!;
    expect(firstRow[0]!.text).toContain('abcd1234');
    expect(firstRow[0]!.callbackData).toBe('session:resume:abcd1234');
    expect(firstRow[1]!.text).toBe('详情');
    expect(firstRow[1]!.callbackData).toBe('session:details:abcd1234');
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow[0]!.text).toBe('🆕 新会话');
    expect(lastRow[0]!.callbackData).toBe('session:new');
  });

  it('--all aggregates across chats and workspaces', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: {
        id: 'sess-0001',
        shortAlias: 'sess0001',
        workspaceId: 'ws-other-0000',
        title: 't1',
        // Owned by a different chat, but --all should include it.
        ownerChat: { channelType: 'feishu', chatId: 'other-c1' },
      } as never,
    });
    await sessionsCmd.run(ctx, ['--all']);
    expect(replies[0]).toContain('所有会话');
    expect(replies[0]).toContain('sess0001');
  });

  it('--global is an alias for --all', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: {
        id: 'sess-0001',
        shortAlias: 'sess0001',
        workspaceId: 'ws-other-0000',
        title: 't1',
        ownerChat: { channelType: 'feishu', chatId: 'other-c1' },
      } as never,
    });
    await sessionsCmd.run(ctx, ['--global']);
    expect(replies[0]).toContain('所有会话');
    expect(replies[0]).toContain('sess0001');
  });

  it('--all from unbound chat works', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await sessionsCmd.run(ctx, ['--all']);
    expect(replies[0]).toContain('暂无会话');
  });

  it('default scope filters by ownerChat (not workspaceId)', async () => {
    // s1 + s3 both belong to telegram:c1 (the inbound), s2 belongs to feishu:c1.
    const { ctx, replies } = buildCtx({
      channelType: 'telegram',
      chatId: 'c1',
      activeSession: {
        id: 's1', shortAlias: 's1', workspaceId: 'ws-1', title: 'tg-1',
        ownerChat: { channelType: 'telegram', chatId: 'c1' },
      } as never,
      sessions: [
        {
          id: 's2', shortAlias: 's2', workspaceId: 'ws-1', title: 'fs-1',
          ownerChat: { channelType: 'feishu', chatId: 'c1' },
        } as never,
        {
          id: 's3', shortAlias: 's3', workspaceId: 'ws-1', title: 'tg-2',
          ownerChat: { channelType: 'telegram', chatId: 'c1' },
        } as never,
      ],
    });
    await sessionsCmd.run(ctx, []);
    expect(replies[0]).toContain('s1');
    expect(replies[0]).toContain('s3');
    expect(replies[0]).not.toContain('s2');
  });

  it('paginates: --page=2 shows entries 9..16 with footer + more hint', async () => {
    const sessions = Array.from({ length: 19 }, (_, i) => ({
      id: `sess-${String(i + 2).padStart(4, '0')}`,
      shortAlias: `sess${String(i + 2).padStart(4, '0')}`,
      title: `t${i + 2}`,
    } as never));
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0001', shortAlias: 'sess0001', title: 't1' } as never,
      sessions,
    });
    await sessionsCmd.run(ctx, ['--page=2']);
    const out = replies[0] ?? '';
    expect(out).toContain('sess0009');
    expect(out).toContain('sess0016');
    expect(out).not.toContain('sess0008');
    expect(out).not.toContain('sess0017');
    expect(out).toMatch(/Page 2\/3/);
    expect(out).toMatch(/--page=3/);
  });

  it('last page footer omits "for more" hint', async () => {
    const sessions = Array.from({ length: 19 }, (_, i) => ({
      id: `sess-${String(i + 2).padStart(4, '0')}`,
      shortAlias: `sess${String(i + 2).padStart(4, '0')}`,
      title: `t${i + 2}`,
    } as never));
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0001', shortAlias: 'sess0001', title: 't1' } as never,
      sessions,
    });
    await sessionsCmd.run(ctx, ['--page=3']);
    const out = replies[0] ?? '';
    expect(out).toMatch(/Page 3\/3/);
    expect(out).not.toMatch(/for more/);
  });
});
