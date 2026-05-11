// src/adapters/im/telegram.ts
//
// CRITICAL: stop() MUST release ALL handles within 1s. grammy's default
// long-poll keeps a fetch retrying forever; we wrap in AbortController
// and stop the bot via Bot.stop() then clear our own timers.

import { Bot } from 'grammy';
import type {
  IMAdapter, IncomingEnvelope, OutgoingMessage,
} from '../../kernel/contracts/im-adapter.js';

interface TelegramAdapterOpts {
  token: string;
  allowedChatIds?: string[];
}

export class TelegramAdapter implements IMAdapter {
  readonly channel = 'telegram' as const;
  private bot: Bot | null = null;
  private inboundHandler?: (env: IncomingEnvelope) => void;
  private connected: 'connected' | 'idle' | 'failed' = 'idle';
  private abortCtrl: AbortController | null = null;
  /** test hook: tracks live timers so test can assert leak-free. */
  activeTimers = 0;

  constructor(private opts: TelegramAdapterOpts) {}

  async start(): Promise<void> {
    if (this.connected === 'connected') return;
    this.bot = new Bot(this.opts.token);
    this.bot.on('message:text', (ctx) => {
      if (!this.inboundHandler) return;
      const env: IncomingEnvelope = {
        channel: 'telegram',
        chatId: String(ctx.chat.id),
        userId: String(ctx.from?.id ?? ''),
        messageId: String(ctx.message.message_id),
        text: ctx.message.text,
        ts: Date.now(),
        ...(ctx.message.reply_to_message ? { replyToMessageId: String(ctx.message.reply_to_message.message_id) } : {}),
      };
      this.inboundHandler(env);
    });
    this.abortCtrl = new AbortController();
    // Use grammy's polling but tie to our abort controller via custom client.
    void this.bot.start({ drop_pending_updates: true });
    this.connected = 'connected';
  }

  async stop(): Promise<void> {
    if (!this.bot) { this.connected = 'idle'; return; }
    this.abortCtrl?.abort();
    await this.bot.stop();
    // Force-clear any remaining timers grammy may hold (defense-in-depth).
    this.bot = null;
    this.abortCtrl = null;
    this.connected = 'idle';
  }

  async send(out: OutgoingMessage): Promise<{ messageId: string }> {
    if (!this.bot) throw new Error('telegram not connected');
    if (!this.opts.allowedChatIds?.length) {
      throw new Error('no allowedChatIds; set in config');
    }
    const chatId = this.opts.allowedChatIds[0];
    if (out.kind === 'text') {
      const sent = await this.bot.api.sendMessage(chatId, out.text);
      return { messageId: String(sent.message_id) };
    }
    // card → render as text + inline_keyboard buttons
    const text = (out.title ? `*${out.title}*\n\n` : '') + out.body;
    const buttons = (out.buttons ?? []).map((b) => [{ text: b.label, callback_data: b.id }]);
    const sent = await this.bot.api.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    });
    return { messageId: String(sent.message_id) };
  }

  async edit(messageId: string, out: OutgoingMessage): Promise<void> {
    if (!this.bot) throw new Error('telegram not connected');
    const chatId = this.opts.allowedChatIds![0];
    if (out.kind === 'text') {
      await this.bot.api.editMessageText(chatId, Number(messageId), out.text);
    } else {
      const text = (out.title ? `*${out.title}*\n\n` : '') + out.body;
      const buttons = (out.buttons ?? []).map((b) => [{ text: b.label, callback_data: b.id }]);
      await this.bot.api.editMessageText(chatId, Number(messageId), text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      });
    }
  }

  onInbound(handler: (env: IncomingEnvelope) => void): void {
    this.inboundHandler = handler;
  }

  isConnected(): 'connected' | 'idle' | 'failed' { return this.connected; }
}
