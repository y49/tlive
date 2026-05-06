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

  it('replies "未绑定工作区" when chat not bound', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await findCmd.run(ctx, ['hello']);
    expect(replies[0]).toMatch(/未绑定工作区/);
  });

  it('reports "未找到匹配" when no hits', async () => {
    discoverMock.mockResolvedValue([]);
    searchMock.mockResolvedValue([]);
    const { ctx, replies } = buildCtx();
    await findCmd.run(ctx, ['foo']);
    expect(replies[0]).toContain('未找到匹配');
    expect(replies[0]).toContain('"foo"');
  });

  it('lists hits with alias + snippet', async () => {
    discoverMock.mockResolvedValue([
      { sdkSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', workdir: '/tmp/ws', provider: 'claude' },
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

  it('filters listings by workspace.workdir', async () => {
    discoverMock.mockResolvedValue([
      { sdkSessionId: 's1', workdir: '/tmp/ws', provider: 'claude' },
      { sdkSessionId: 's2', workdir: '/tmp/other', provider: 'claude' },
    ]);
    searchMock.mockImplementation((listings: unknown[]) => {
      // Assert filtering already happened
      expect(listings).toHaveLength(1);
      expect((listings[0] as { workdir: string }).workdir).toBe('/tmp/ws');
      return [];
    });
    const { ctx } = buildCtx();
    await findCmd.run(ctx, ['anything']);
    expect(searchMock).toHaveBeenCalledOnce();
  });

  it('handles discoverSessions throwing with error message', async () => {
    discoverMock.mockRejectedValue(new Error('disk read failed'));
    const { ctx, replies } = buildCtx();
    await findCmd.run(ctx, ['x']);
    expect(replies[0]).toMatch(/搜索失败.*disk read failed/);
  });
});
