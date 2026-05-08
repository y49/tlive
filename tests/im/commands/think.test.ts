import { describe, it, expect } from 'vitest';
import { thinkCmd } from '../../../src/im/commands/think.js';
import { buildCtx } from './_helpers.js';

describe('/think', () => {
  it('no-args: shows current + 3 level buttons with ✅ on current', async () => {
    const { ctx, replies, replyMarkups } = buildCtx({
      workspace: {
        defaults: {
          provider: 'claude',
          permissionMode: 'default',
          thinking: 'collapsed',
          verbose: false,
          prewarmCache: false,
          threadPerSession: false,
        } as never,
      },
    });
    await thinkCmd.run(ctx, []);
    expect(replies[0]).toMatch(/collapsed/);
    const labels = (replyMarkups[0]!.buttons!).flat().map((b) => b.text);
    ['collapsed', 'expanded', 'hidden'].forEach((l) => {
      expect(labels.some((t) => t.includes(l))).toBe(true);
    });
    expect(labels.some((l) => l.includes('✅') && l.includes('collapsed'))).toBe(true);
    // Callback data
    const expandedBtn = (replyMarkups[0]!.buttons!).flat().find((b) => b.text.includes('expanded') && !b.text.includes('✅'));
    expect(expandedBtn?.callbackData).toBe('runtime:think:set:expanded');
  });

  it('with valid arg: persists workspace default', async () => {
    const { ctx, replies, ws, workspaceCalls } = buildCtx({
      workspace: {
        defaults: {
          provider: 'claude',
          permissionMode: 'default',
          thinking: 'collapsed',
          verbose: false,
          prewarmCache: false,
          threadPerSession: false,
        } as never,
      },
    });
    await thinkCmd.run(ctx, ['expanded']);
    expect(ws?.defaults.thinking).toBe('expanded');
    expect(workspaceCalls.some((c) => c.method === 'save')).toBe(true);
    expect(replies[0]).toMatch(/expanded/);
  });

  it('with invalid arg: rejects', async () => {
    const { ctx, replies } = buildCtx({ workspace: {} });
    await thinkCmd.run(ctx, ['bogus']);
    expect(replies[0]).toMatch(/无效/);
  });

  it('no workspace: friendly prompt', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await thinkCmd.run(ctx, []);
    expect(replies[0]).toMatch(/未绑定/);
  });

  it('alias /thinking still works', () => {
    expect(thinkCmd.aliases).toContain('thinking');
  });
});
