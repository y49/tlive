import { describe, it, expect } from 'vitest';
import { costCmd } from '../../../src/im/commands/cost.js';
import { buildCtx } from './_helpers.js';

describe('/cost', () => {
  it('replies with prompt when chat is unbound and no --all', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await costCmd.run(ctx, []);
    expect(replies[0]).toMatch(/未绑定工作区/);
  });

  it('default scope: live-only fallback when no rollupStore, ws-filtered', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess1', shortAlias: 'sess1' } as never,
    });
    await costCmd.run(ctx, []);
    expect(replies[0]).toMatch(/💰 test-ws \(today\)/);
    expect(replies[0]).toContain('1 live sessions');
  });

  it('--all uses all-workspaces scope label', async () => {
    const { ctx, replies } = buildCtx();
    await costCmd.run(ctx, ['--all']);
    expect(replies[0]).toContain('所有工作区');
  });

  it('--global is alias for --all', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await costCmd.run(ctx, ['--global']);
    expect(replies[0]).toContain('所有工作区');
  });

  it('uses rollup store when wired', async () => {
    const { ctx, replies, ws } = buildCtx();
    ctx.rollupStore = {
      load: async () => [
        {
          workspaceId: ws!.id,
          sdkSessionId: 's1',
          dateKey: '2026-04-22',
          deltaUsd: 0.5,
          deltaIn: 100,
          deltaOut: 200,
          at: Date.now(),
        },
      ],
    } as unknown as Parameters<typeof costCmd.run>[0]['rollupStore'];
    await costCmd.run(ctx, ['week']);
    expect(replies[0]).toContain('💰 test-ws (week)');
    expect(replies[0]).toContain('0.5000');
  });

  it('total range scopes since=0 (lifetime)', async () => {
    const { ctx, replies, ws } = buildCtx();
    ctx.rollupStore = {
      load: async () => [
        {
          workspaceId: ws!.id,
          sdkSessionId: 's1',
          dateKey: '2020-01-01',
          deltaUsd: 1.25,
          deltaIn: 0,
          deltaOut: 0,
          at: 0, // very old — must still appear under total
        },
      ],
    } as unknown as Parameters<typeof costCmd.run>[0]['rollupStore'];
    await costCmd.run(ctx, ['total']);
    expect(replies[0]).toContain('(total)');
    expect(replies[0]).toContain('1.2500');
  });
});
