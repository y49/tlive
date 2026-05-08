import { describe, it, expect } from 'vitest';
import { costCmd } from '../../../src/im/commands/cost.js';
import { buildCtx } from './_helpers.js';

describe('/cost', () => {
  it('replies with prompt when chat is unbound', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await costCmd.run(ctx, []);
    expect(replies[0]).toMatch(/未绑定工作区/);
  });

  it('default scope: shows current chat costRollup', async () => {
    const { ctx, replies, ws } = buildCtx();
    // Seed some cost on the chat instance via wm.addCost
    ctx.workspaceManager.addCost('telegram', '12345', 0.25, true);
    await costCmd.run(ctx, []);
    expect(replies[0]).toMatch(/💰 此 chat/);
    expect(replies[0]).toContain('$0.2500');
    expect(replies[0]).toContain('1 sessions');
    // ws is used only to confirm workspace exists (no assertion on ws here)
    void ws;
  });

  it('--all uses global scope across all chat instances', async () => {
    const { ctx, replies } = buildCtx();
    ctx.workspaceManager.addCost('telegram', '12345', 0.5, true);
    await costCmd.run(ctx, ['--all']);
    expect(replies[0]).toMatch(/💰 全部 chat/);
    expect(replies[0]).toContain('$0.5000');
  });

  it('--global is alias for --all', async () => {
    const { ctx, replies } = buildCtx();
    await costCmd.run(ctx, ['--global']);
    expect(replies[0]).toMatch(/💰 全部 chat/);
  });

  it('--workspace replies with "未绑定" when chat is unbound', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await costCmd.run(ctx, ['--workspace']);
    expect(replies[0]).toMatch(/未绑定工作区/);
  });

  it('--workspace shows per-chat breakdown of same workspace + total', async () => {
    const { ctx, replies } = buildCtx();
    // chatId is '12345' per _helpers default
    ctx.workspaceManager.addCost('telegram', '12345', 1.0, true);
    await costCmd.run(ctx, ['--workspace']);
    expect(replies[0]).toMatch(/📊 workspace test-ws 总和/);
    expect(replies[0]).toMatch(/合计.*\$1\.0/);
    expect(replies[0]).toMatch(/chat 12345/);
  });
});
