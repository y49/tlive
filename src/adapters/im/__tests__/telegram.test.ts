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

// --- outbound card rendering (Telegram HTML) ---

describe('send() card rendering', () => {
  async function adapterWithApi() {
    const a = new TelegramAdapter({ token: 'T', allowedChatIds: ['100'] });
    await a.start();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 7 });
    (a as any).bot.api = { sendMessage };
    return { a, sendMessage };
  }

  it('sends cards as HTML with converted body and bold title', async () => {
    const { a, sendMessage } = await adapterWithApi();
    await a.send({ kind: 'card', title: 'Approval: Bash', body: 'run `ls`\n```bash\nls -la\n```' });
    const [, text, opts] = sendMessage.mock.calls[0];
    expect(opts.parse_mode).toBe('HTML');
    expect(text).toContain('<b>Approval: Bash</b>');
    expect(text).toContain('<pre><code class="language-bash">ls -la</code></pre>');
    expect(text).toContain('run <code>ls</code>');
  });

  it('escapes HTML in the title', async () => {
    const { a, sendMessage } = await adapterWithApi();
    await a.send({ kind: 'card', title: 'x <&> y', body: 'b' });
    expect(sendMessage.mock.calls[0][1]).toContain('<b>x &lt;&amp;&gt; y</b>');
  });

  it('lays buttons out two per row', async () => {
    const { a, sendMessage } = await adapterWithApi();
    await a.send({
      kind: 'card', title: 't', body: 'b',
      buttons: [
        { id: 'a', label: 'Allow' }, { id: 'd', label: 'Deny' },
        { id: 'w', label: 'Always' }, { id: 'p', label: 'Pause' },
      ],
    });
    const kb = sendMessage.mock.calls[0][2].reply_markup.inline_keyboard;
    expect(kb).toHaveLength(2);
    expect(kb[0].map((b: { text: string }) => b.text)).toEqual(['Allow', 'Deny']);
    expect(kb[1].map((b: { text: string }) => b.text)).toEqual(['Always', 'Pause']);
  });

  it('falls back to plain text when HTML parsing is rejected', async () => {
    const { a, sendMessage } = await adapterWithApi();
    sendMessage
      .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
      .mockResolvedValueOnce({ message_id: 9 });
    const r = await a.send({ kind: 'card', title: 't', body: 'b' });
    expect(r.messageId).toBe('9');
    expect(sendMessage.mock.calls[1][2]?.parse_mode).toBeUndefined();
  });
});
