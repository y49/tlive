import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildCtx } from './_helpers.js';

// Mock discovery + search modules so the test doesn't hit the filesystem.
const discoverMock = vi.fn();
const searchMock = vi.fn();
vi.mock('../../../src/session/discovery.js', () => ({
  discoverSessions: (...args: unknown[]) => discoverMock(...args),
}));
vi.mock('../../../src/session/search.js', () => ({
  searchSessions: (...args: unknown[]) => searchMock(...args),
}));

// Import AFTER vi.mock so the SUT picks up the mocked deps.
const { findCmd } = await import('../../../src/im/commands/find.js');

describe('/find', () => {
  beforeEach(() => {
    discoverMock.mockReset();
    searchMock.mockReset();
  });

  it('shows usage prompt when no args', async () => {
    const { ctx, replies } = buildCtx();
    await findCmd.run(ctx, []);
    expect(replies[0]).toMatch(/用法:.*\/find/);
  });

  it('replies "未绑定工作区" when chat not bound and --workspace flag used', async () => {
    discoverMock.mockResolvedValue([]);
    const { ctx, replies } = buildCtx({ workspace: null });
    await findCmd.run(ctx, ['hello', '--workspace']);
    expect(replies[0]).toMatch(/未绑定工作区/);
  });

  it('reports "未找到匹配" when no hits (default scope)', async () => {
    discoverMock.mockResolvedValue([]);
    searchMock.mockResolvedValue([]);
    const { ctx, replies } = buildCtx();
    await findCmd.run(ctx, ['foo']);
    expect(replies[0]).toContain('未找到匹配');
    expect(replies[0]).toContain('"foo"');
  });

  it('lists hits with alias + snippet', async () => {
    discoverMock.mockResolvedValue([
      { sdkSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', workdir: '/tmp/ws', provider: 'claude',
        ownerChat: { channelType: 'telegram', chatId: '12345' } },
    ]);
    searchMock.mockResolvedValue([
      {
        sdkSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        provider: 'claude' as const,
        workdir: '/tmp/ws',
        snippet: '...OAuth flow done...',
        matchedAt: Date.now(),
      },
    ]);
    const { ctx, replies } = buildCtx();
    await findCmd.run(ctx, ['OAuth']);
    expect(replies[0]).toContain('1 条匹配');
    expect(replies[0]).toContain('aaaaaaaa');
    expect(replies[0]).toContain('OAuth flow done');
  });

  it('--workspace filters listings by workspace.workdir', async () => {
    discoverMock.mockResolvedValue([
      { sdkSessionId: 's1', workdir: '/tmp/ws', provider: 'claude' },
      { sdkSessionId: 's2', workdir: '/tmp/other', provider: 'claude' },
    ]);
    searchMock.mockImplementation((listings: unknown[]) => {
      // Assert filtering already happened to workspace workdir only
      expect(listings).toHaveLength(1);
      expect((listings[0] as { workdir: string }).workdir).toBe('/tmp/ws');
      return [];
    });
    const { ctx } = buildCtx();
    await findCmd.run(ctx, ['anything', '--workspace']);
    expect(searchMock).toHaveBeenCalledOnce();
  });

  it('handles discoverSessions throwing with error message', async () => {
    discoverMock.mockRejectedValue(new Error('disk read failed'));
    const { ctx, replies } = buildCtx();
    await findCmd.run(ctx, ['x']);
    expect(replies[0]).toMatch(/搜索失败.*disk read failed/);
  });

  // --- scope tests ---

  it('default scope filters by ownerChat (current chat)', async () => {
    // 2 sessions owned by tg:12345, 1 owned by feishu:fs-x — all same workdir
    discoverMock.mockResolvedValue([
      { sdkSessionId: 's1', workdir: '/tmp/ws', provider: 'claude',
        ownerChat: { channelType: 'telegram', chatId: '12345' } },
      { sdkSessionId: 's2', workdir: '/tmp/ws', provider: 'claude',
        ownerChat: { channelType: 'telegram', chatId: '12345' } },
      { sdkSessionId: 's3', workdir: '/tmp/ws', provider: 'claude',
        ownerChat: { channelType: 'feishu', chatId: 'fs-x' } },
    ]);
    searchMock.mockImplementation((listings: unknown[]) => {
      // Only the 2 owned by tg:12345 should pass the filter
      expect(listings).toHaveLength(2);
      expect((listings as Array<{ sdkSessionId: string }>).map((l) => l.sdkSessionId).sort())
        .toEqual(['s1', 's2']);
      return Promise.resolve([
        { sdkSessionId: 's1', provider: 'claude', workdir: '/tmp/ws', snippet: 'needle hit 1', matchedAt: 1 },
        { sdkSessionId: 's2', provider: 'claude', workdir: '/tmp/ws', snippet: 'needle hit 2', matchedAt: 2 },
      ]);
    });
    // buildCtx defaults channelType='telegram', chatId='12345'
    const { ctx, replies } = buildCtx();
    await findCmd.run(ctx, ['needle']);
    expect(replies[0]).toContain('2 条匹配');
    expect(replies[0]).toContain('当前 chat');
  });

  it('--workspace scope filters by workdir across chats', async () => {
    // 2 sessions from tg:12345, 1 from feishu:fs-x — all same ws workdir
    // plus 1 from a different ws workdir
    discoverMock.mockResolvedValue([
      { sdkSessionId: 's1', workdir: '/tmp/ws', provider: 'claude',
        ownerChat: { channelType: 'telegram', chatId: '12345' } },
      { sdkSessionId: 's2', workdir: '/tmp/ws', provider: 'claude',
        ownerChat: { channelType: 'feishu', chatId: 'fs-x' } },
      { sdkSessionId: 's3', workdir: '/tmp/ws', provider: 'claude',
        ownerChat: { channelType: 'telegram', chatId: '12345' } },
      { sdkSessionId: 's4', workdir: '/tmp/other-ws', provider: 'claude',
        ownerChat: { channelType: 'telegram', chatId: 'tg-other' } },
    ]);
    searchMock.mockImplementation((listings: unknown[]) => {
      // Only the 3 with workdir='/tmp/ws' should pass
      expect(listings).toHaveLength(3);
      return Promise.resolve([
        { sdkSessionId: 's1', provider: 'claude', workdir: '/tmp/ws', snippet: 'needle 1', matchedAt: 1 },
        { sdkSessionId: 's2', provider: 'claude', workdir: '/tmp/ws', snippet: 'needle 2', matchedAt: 2 },
        { sdkSessionId: 's3', provider: 'claude', workdir: '/tmp/ws', snippet: 'needle 3', matchedAt: 3 },
      ]);
    });
    // buildCtx workspace.workdir defaults to '/tmp/ws'
    const { ctx, replies } = buildCtx();
    await findCmd.run(ctx, ['needle', '--workspace']);
    expect(replies[0]).toContain('3 条匹配');
    expect(replies[0]).toContain('当前 ws');
  });

  it('--all scope returns results from all chats', async () => {
    // 3 sessions across 2 ws, multiple chats
    discoverMock.mockResolvedValue([
      { sdkSessionId: 's1', workdir: '/tmp/ws', provider: 'claude',
        ownerChat: { channelType: 'telegram', chatId: '12345' } },
      { sdkSessionId: 's2', workdir: '/tmp/ws', provider: 'claude',
        ownerChat: { channelType: 'feishu', chatId: 'fs-x' } },
      { sdkSessionId: 's3', workdir: '/tmp/other-ws', provider: 'claude',
        ownerChat: { channelType: 'telegram', chatId: 'tg-other' } },
      { sdkSessionId: 's4', workdir: '/tmp/other-ws2', provider: 'claude',
        ownerChat: { channelType: 'telegram', chatId: 'tg-x' } },
    ]);
    searchMock.mockImplementation((listings: unknown[]) => {
      // All 4 listings should be passed through
      expect(listings).toHaveLength(4);
      return Promise.resolve([
        { sdkSessionId: 's1', provider: 'claude', workdir: '/tmp/ws', snippet: 'hit 1', matchedAt: 1 },
        { sdkSessionId: 's2', provider: 'claude', workdir: '/tmp/ws', snippet: 'hit 2', matchedAt: 2 },
        { sdkSessionId: 's3', provider: 'claude', workdir: '/tmp/other-ws', snippet: 'hit 3', matchedAt: 3 },
        { sdkSessionId: 's4', provider: 'claude', workdir: '/tmp/other-ws2', snippet: 'hit 4', matchedAt: 4 },
      ]);
    });
    const { ctx, replies } = buildCtx();
    await findCmd.run(ctx, ['needle', '--all']);
    expect(replies[0]).toContain('4 条匹配');
    expect(replies[0]).toContain('全部 chat');
  });
});
