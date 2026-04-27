import { describe, it, expect } from 'vitest';
import { newCmd } from '../../../src/im/commands/new.js';
import { buildCtx } from './_helpers.js';

describe('/new', () => {
  it('creates a session with prompt from trailing args', async () => {
    const { ctx, replies, sessionCalls } = buildCtx();
    await newCmd.run(ctx, ['hello', 'world']);
    const call = sessionCalls.find((c) => c.method === 'createLocal');
    expect(call).toBeDefined();
    expect((call!.args[0] as { initialPrompt?: string }).initialPrompt).toBe('hello world');
    expect(replies[0]).toMatch(/Session .* started/);
  });

  it('supports --ephemeral + --model flags', async () => {
    const { ctx, replies, sessionCalls } = buildCtx();
    await newCmd.run(ctx, ['--ephemeral', '--model=claude-sonnet-99', 'test']);
    const call = sessionCalls.find((c) => c.method === 'createLocal');
    expect((call!.args[0] as { model?: string }).model).toBe('claude-sonnet-99');
    expect(replies[0]).toContain('(ephemeral)');
  });

  it('replies when no workspace bound', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await newCmd.run(ctx, ['hi']);
    expect(replies[0]).toMatch(/not bound to a workspace/);
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
});
