import { describe, it, expect } from 'vitest';
import { modelCmd } from '../../../src/im/commands/model.js';
import { buildCtx } from './_helpers.js';

describe('/model', () => {
  it('no-args: shows current + button list from supportedModels', async () => {
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      sdkModel: 'claude-sonnet-4-6',
      runtime: {
        supportedModels: async () => [
          { id: 'claude-opus-4-7', displayName: 'Opus 4.7' },
          { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
          { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
        ],
      },
      setModel: async () => {},
    };
    const { ctx, replies, replyMarkups } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await modelCmd.run(ctx, []);
    expect(replies[0]).toMatch(/sonnet-4-6/);
    const buttons = (replyMarkups[0]!.buttons!).flat();
    const labels = buttons.map((b) => b.text);
    expect(labels.some((l) => l.includes('Opus 4.7'))).toBe(true);
    expect(labels.some((l) => l.includes('Sonnet 4.6'))).toBe(true);
    expect(labels.some((l) => l.includes('Haiku 4.5'))).toBe(true);
    expect(labels).toContain('✏ 自定义');
    // ✓ marker on current
    expect(labels.some((l) => l.includes('Sonnet 4.6 ✓'))).toBe(true);
    // Callback data uses runtime:model:set:<id>
    const opusBtn = buttons.find((b) => b.text.includes('Opus 4.7'));
    expect(opusBtn?.callbackData).toBe('runtime:model:set:claude-opus-4-7');
  });

  it('no-args, no session: shows picker with workspace default', async () => {
    const { ctx, replies, replyMarkups } = buildCtx({
      workspace: {
        activeSessionId: null,
        defaults: {
          provider: 'claude',
          model: 'gpt-5',
          permissionMode: 'default',
          thinking: 'collapsed',
        } as never,
      },
    });
    await modelCmd.run(ctx, []);
    // No active session → no supportedModels available → picker still has [✏ 自定义]
    expect(replies[0]).toMatch(/gpt-5/);
    const labels = (replyMarkups[0]!.buttons!).flat().map((b) => b.text);
    expect(labels).toContain('✏ 自定义');
  });

  it('with arg: calls setModel + persists workspace default', async () => {
    let setTo = '';
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      setModel: async (m: string) => {
        setTo = m;
      },
      runtime: { supportedModels: async () => [] },
    };
    const { ctx, replies, ws, workspaceCalls } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await modelCmd.run(ctx, ['claude-opus-4-7']);
    expect(setTo).toBe('claude-opus-4-7');
    expect(ws?.defaults.model).toBe('claude-opus-4-7');
    expect(workspaceCalls.some((c) => c.method === 'save')).toBe(true);
    expect(replies[0]).toMatch(/已切到.*claude-opus-4-7/);
  });

  it('with arg + no active session: still persists workspace default', async () => {
    const { ctx, replies, ws } = buildCtx({
      workspace: { activeSessionId: null },
    });
    await modelCmd.run(ctx, ['gpt-5-mini']);
    expect(ws?.defaults.model).toBe('gpt-5-mini');
    expect(replies[0]).toMatch(/已切到.*gpt-5-mini/);
  });

  it('with arg + setModel throws: replies with error', async () => {
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      setModel: async () => {
        throw new Error('unsupported');
      },
      runtime: { supportedModels: async () => [] },
    };
    const { ctx, replies, ws } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await modelCmd.run(ctx, ['bogus-model']);
    expect(replies[0]).toMatch(/切换失败/);
    // Workspace default must NOT be persisted when setModel fails.
    expect(ws?.defaults.model).not.toBe('bogus-model');
  });

  it('no workspace: friendly prompt to /workspace', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await modelCmd.run(ctx, []);
    expect(replies[0]).toMatch(/未绑定|工作区/);
  });

  it('no-args: shows [设为 workspace 默认] when current differs from ws default', async () => {
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      sdkModel: 'claude-opus-4-7', // session running opus
      runtime: { supportedModels: async () => [] },
      setModel: async () => {},
    };
    const { ctx, replyMarkups } = buildCtx({
      workspace: {
        activeSessionId: 's1',
        defaults: {
          provider: 'claude',
          model: 'claude-sonnet-4-6', // ws default sonnet
          permissionMode: 'default',
          thinking: 'collapsed',
        } as never,
      },
      activeSession: fakeSession as never,
    });
    await modelCmd.run(ctx, []);
    const labels = (replyMarkups[0]!.buttons!).flat().map((b) => b.text);
    expect(labels).toContain('设为 workspace 默认');
  });
});
