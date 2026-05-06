import { describe, it, expect } from 'vitest';
import { sessionsCmd } from '../../../src/im/commands/sessions.js';
import { buildCtx } from './_helpers.js';

describe('/sessions', () => {
  it('replies with prompt when chat is not bound and no --all', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await sessionsCmd.run(ctx, []);
    expect(replies[0]).toMatch(/未绑定工作区/);
  });

  it('default scope: shows empty card with 🆕 新会话 button when ws has no sessions', async () => {
    const { ctx, replies, replyMarkups } = buildCtx();
    await sessionsCmd.run(ctx, []);
    expect(replies[0]).toContain('暂无会话');
    expect(replies[0]).toContain('test-ws');
    const buttons = (replyMarkups[0]!.buttons!).flat();
    expect(buttons[0]?.text).toBe('🆕 新会话');
    expect(buttons[0]?.callbackData).toBe('session:new');
  });

  it('default scope: filters out sessions from other workspaces', async () => {
    const { ctx, replies, replyMarkups } = buildCtx({
      activeSession: {
        id: 'sess-0001-0001-0001-0001',
        shortAlias: 'sess0001',
        workspaceId: 'ws-other-0000',
        title: 'other-ws-session',
      } as never,
    });
    // The activeSession has a foreign workspaceId, so default-scope should
    // filter it out and show empty.
    await sessionsCmd.run(ctx, []);
    expect(replies[0]).toContain('暂无会话');
    expect(replies[0]).not.toContain('sess0001');
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

  it('--all aggregates across workspaces', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: {
        id: 'sess-0001',
        shortAlias: 'sess0001',
        workspaceId: 'ws-other-0000',
        title: 't1',
      } as never,
    });
    await sessionsCmd.run(ctx, ['--all']);
    expect(replies[0]).toContain('所有工作区');
    expect(replies[0]).toContain('sess0001');
  });

  it('--global is an alias for --all', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: {
        id: 'sess-0001',
        shortAlias: 'sess0001',
        workspaceId: 'ws-other-0000',
        title: 't1',
      } as never,
    });
    await sessionsCmd.run(ctx, ['--global']);
    expect(replies[0]).toContain('所有工作区');
    expect(replies[0]).toContain('sess0001');
  });

  it('--all from unbound chat works', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await sessionsCmd.run(ctx, ['--all']);
    expect(replies[0]).toContain('暂无会话');
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
