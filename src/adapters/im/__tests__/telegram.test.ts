import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('grammy', () => ({
  Bot: class { start = vi.fn(); stop = vi.fn(); on = vi.fn(); api = {}; },
}));

import { TelegramAdapter } from '../telegram.js';

describe('TelegramAdapter', () => {
  it('start + stop without throwing', async () => {
    const a = new TelegramAdapter({ token: 'T' });
    await a.start();
    expect(a.isConnected()).toBe('connected');
    await a.stop();
    expect(a.isConnected()).toBe('idle');
  });

  it('stop is idempotent', async () => {
    const a = new TelegramAdapter({ token: 'T' });
    await a.start();
    await a.stop(); await a.stop();
    expect(a.isConnected()).toBe('idle');
  });

  it('exposes handles count via test hook (must be 0 after stop)', async () => {
    const a = new TelegramAdapter({ token: 'T' });
    await a.start();
    await a.stop();
    expect((a as any).activeTimers).toBe(0);
  });

  // --- inbound chat filter (fail-closed) ---

  describe('inbound text filter', () => {
    let a: TelegramAdapter;
    let inbound: ReturnType<typeof vi.fn>;
    let textHandler: (ctx: Record<string, unknown>) => void;
    let callbackHandler: (ctx: Record<string, unknown>) => void;

    beforeEach(async () => {
      a = new TelegramAdapter({ token: 'T', allowedChatIds: ['100'] });
      await a.start();
      inbound = vi.fn();
      a.onInbound(inbound);

      // Capture registered grammy event handlers from mock Bot.on calls
      const bot = (a as any).bot as { on: ReturnType<typeof vi.fn> };
      const onCalls: [string, (ctx: Record<string, unknown>) => void][] = bot.on.mock.calls as [string, (ctx: Record<string, unknown>) => void][];
      textHandler = onCalls.find((c) => c[0] === 'message:text')![1];
      callbackHandler = onCalls.find((c) => c[0] === 'callback_query:data')![1];
    });

    it('forwards text from configured chat', () => {
      textHandler({
        chat: { id: 100 },
        from: { id: 1 },
        message: { message_id: 1, text: 'hello' },
      });
      expect(inbound).toHaveBeenCalledOnce();
      expect(inbound.mock.calls[0][0]).toMatchObject({ chatId: '100', text: 'hello' });
    });

    it('drops text from non-configured chat', () => {
      textHandler({
        chat: { id: 999 },
        from: { id: 1 },
        message: { message_id: 1, text: 'hello' },
      });
      expect(inbound).not.toHaveBeenCalled();
    });

    it('drops text when allowedChatIds is empty (fail-closed)', async () => {
      const a2 = new TelegramAdapter({ token: 'T', allowedChatIds: [] });
      await a2.start();
      const inbound2 = vi.fn();
      a2.onInbound(inbound2);
      const bot2 = (a2 as any).bot as { on: ReturnType<typeof vi.fn> };
      const onCalls2 = bot2.on.mock.calls as [string, (ctx: Record<string, unknown>) => void][];
      const textHandler2 = onCalls2.find((c) => c[0] === 'message:text')![1];
      textHandler2({ chat: { id: 100 }, from: { id: 1 }, message: { message_id: 1, text: 'hi' } });
      expect(inbound2).not.toHaveBeenCalled();
      await a2.stop();
    });
  });

  describe('inbound callback filter', () => {
    let a: TelegramAdapter;
    let inbound: ReturnType<typeof vi.fn>;
    let callbackHandler: (ctx: Record<string, unknown>) => void;

    beforeEach(async () => {
      a = new TelegramAdapter({ token: 'T', allowedChatIds: ['100'] });
      await a.start();
      inbound = vi.fn();
      a.onInbound(inbound);
      const bot = (a as any).bot as { on: ReturnType<typeof vi.fn> };
      const onCalls = bot.on.mock.calls as [string, (ctx: Record<string, unknown>) => void][];
      callbackHandler = onCalls.find((c) => c[0] === 'callback_query:data')![1];
    });

    it('forwards callback from configured chat', () => {
      callbackHandler({
        callbackQuery: {
          data: 'approve:xyz',
          message: { chat: { id: 100 }, message_id: 2 },
          from: { id: 1 },
        },
        answerCallbackQuery: vi.fn(async () => undefined),
      });
      expect(inbound).toHaveBeenCalledOnce();
      expect(inbound.mock.calls[0][0]).toMatchObject({ chatId: '100', text: 'approve:xyz' });
    });

    it('drops callback from non-configured chat', () => {
      callbackHandler({
        callbackQuery: {
          data: 'approve:xyz',
          message: { chat: { id: 999 }, message_id: 2 },
          from: { id: 1 },
        },
        answerCallbackQuery: vi.fn(async () => undefined),
      });
      expect(inbound).not.toHaveBeenCalled();
    });

    it('drops callback when allowedChatIds is absent (fail-closed)', async () => {
      const a2 = new TelegramAdapter({ token: 'T' });
      await a2.start();
      const inbound2 = vi.fn();
      a2.onInbound(inbound2);
      const bot2 = (a2 as any).bot as { on: ReturnType<typeof vi.fn> };
      const onCalls2 = bot2.on.mock.calls as [string, (ctx: Record<string, unknown>) => void][];
      const handler2 = onCalls2.find((c) => c[0] === 'callback_query:data')![1];
      handler2({
        callbackQuery: { data: 'approve:abc', message: { chat: { id: 100 }, message_id: 1 }, from: { id: 1 } },
        answerCallbackQuery: vi.fn(async () => undefined),
      });
      expect(inbound2).not.toHaveBeenCalled();
      await a2.stop();
    });
  });
});
