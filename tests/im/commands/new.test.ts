import { describe, it, expect } from 'vitest';
import { newCmd } from '../../../src/im/commands/new.js';
import { buildCtx } from './_helpers.js';

describe('/new', () => {
  it('replies "未绑定工作区" when chat not bound', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await newCmd.run(ctx, ['hi']);
    expect(replies[0]).toMatch(/未绑定工作区/);
  });

  it('fresh workspace: creates a session with prompt from trailing args', async () => {
    const { ctx, replies, sessionCalls } = buildCtx();
    await newCmd.run(ctx, ['hello', 'world']);
    const call = sessionCalls.find((c) => c.method === 'createLocal');
    expect(call).toBeDefined();
    expect((call!.args[0] as { initialPrompt?: string }).initialPrompt).toBe('hello world');
    expect(replies[0]).toMatch(/✅ 会话 .* 已起/);
    expect(replies[0]).toContain('test-ws');
  });

  it('supports --ephemeral + --model flags', async () => {
    const { ctx, replies, sessionCalls } = buildCtx();
    await newCmd.run(ctx, ['--ephemeral', '--model=claude-sonnet-99', 'test']);
    const call = sessionCalls.find((c) => c.method === 'createLocal');
    expect((call!.args[0] as { model?: string }).model).toBe('claude-sonnet-99');
    expect(replies[0]).toContain('(ephemeral)');
  });

  it('strips balanced outer double quotes from the prompt', async () => {
    const { ctx, sessionCalls } = buildCtx();
    await newCmd.run(ctx, ['"hello', 'world"']);
    const call = sessionCalls.find((c) => c.method === 'createLocal');
    expect((call!.args[0] as { initialPrompt?: string }).initialPrompt).toBe('hello world');
  });

  it('strips balanced outer single quotes from the prompt', async () => {
    const { ctx, sessionCalls } = buildCtx();
    await newCmd.run(ctx, ["'single", "quoted'"]);
    const call = sessionCalls.find((c) => c.method === 'createLocal');
    expect((call!.args[0] as { initialPrompt?: string }).initialPrompt).toBe('single quoted');
  });

  it('leaves unbalanced quotes alone', async () => {
    const { ctx, sessionCalls } = buildCtx();
    await newCmd.run(ctx, ['"unbalanced']);
    const call = sessionCalls.find((c) => c.method === 'createLocal');
    expect((call!.args[0] as { initialPrompt?: string }).initialPrompt).toBe('"unbalanced');
  });

  it('with active session and no --force: emits confirm-replace card', async () => {
    const { ctx, replies, replyMarkups, sessionCalls } = buildCtx({
      workspace: { activeSessionId: 'sess-active' },
      activeSession: { id: 'sess-active', shortAlias: 'aaaaaaaa' } as never,
    });
    await newCmd.run(ctx, ['something']);
    expect(replies[0]).toMatch(/已有活跃会话/);
    expect(replies[0]).toContain('aaaaaaaa');
    const buttons = (replyMarkups[0]!.buttons!).flat();
    expect(buttons[0]?.text).toBe('✅ 替换');
    expect(buttons[0]?.callbackData).toBe('session:new:confirm');
    expect(buttons[1]?.text).toBe('❌ 取消');
    expect(buttons[1]?.callbackData).toBe('session:new:cancel');
    // No createLocal yet — waiting on confirm
    expect(sessionCalls.find((c) => c.method === 'createLocal')).toBeUndefined();
  });

  it('--force replaces active session: clears + creates new', async () => {
    const stopCalls: number[] = [];
    const { ctx, replies, sessionCalls, workspaceCalls } = buildCtx({
      workspace: { activeSessionId: 'sess-active' },
      activeSession: {
        id: 'sess-active',
        shortAlias: 'aaaaaaaa',
        stop: async () => { stopCalls.push(1); },
      } as never,
    });
    await newCmd.run(ctx, ['--force', 'hi']);
    expect(stopCalls.length).toBe(1);
    expect(workspaceCalls.find((c) => c.method === 'clearActiveSession')).toBeDefined();
    expect(sessionCalls.find((c) => c.method === 'createLocal')).toBeDefined();
    expect(replies[0]).toMatch(/✅ 会话 .* 已起/);
  });

});
