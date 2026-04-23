// src/platform/telegram/adapter.ts
//
// PlatformAdapter for Telegram, powered by grammy. Uses grammy's built-in
// long-polling runner by default; callers can swap in a webhook receiver by
// providing their own `start`/`stop` hooks — see ctor options.
//
// Messages returned by the Bot API carry numeric ids; we stringify them so
// the platform-agnostic renderer layer doesn't need to care about number vs
// string.

import { Bot, type Context } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import type {
  PlatformAdapter, OutboundMessage, OutboundAttachment, InboundEvent, ReplyMarkup, ParseMode,
} from '../types.js';
import type { ChannelType } from '../../workspace/bindings.js';
import { replyMarkupToTelegram, escapeMarkdownV2 } from './renderer.js';
import { sendTelegramAttachment, downloadTelegramFile } from './attachment.js';

export interface TelegramAdapterOptions {
  token: string;
  /** Inject a pre-built Bot (for tests / dependency injection). */
  bot?: Bot;
  /** Disable @grammyjs/runner startup (tests drive inbound manually). */
  skipRunner?: boolean;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly channelType: ChannelType = 'telegram';
  private readonly bot: Bot;
  private runner: RunnerHandle | null = null;
  private readonly inboundListeners = new Set<(ev: InboundEvent) => void>();
  private readonly options: TelegramAdapterOptions;

  constructor(options: TelegramAdapterOptions) {
    this.options = options;
    this.bot = options.bot ?? new Bot(options.token);
    this.wireGrammyHandlers();
  }

  async start(): Promise<void> {
    if (this.runner || this.options.skipRunner) return;
    this.runner = run(this.bot);
  }

  async stop(): Promise<void> {
    if (this.runner) {
      await this.runner.stop();
      this.runner = null;
    }
  }

  async send(msg: OutboundMessage): Promise<string> {
    const chat = Number(msg.chatId);
    const extra = this.buildExtra(msg.replyMarkup, msg.parseMode, msg.threadId, msg.replyToMessageId, msg.silent);
    const text = msg.text ?? '';
    if (msg.attachment) {
      return sendTelegramAttachment(this.bot, {
        chatId: msg.chatId,
        attachment: { ...msg.attachment, caption: msg.text },
        threadId: msg.threadId,
        replyMarkup: extra.reply_markup as object | undefined,
      });
    }
    const sent = await this.bot.api.sendMessage(chat, this.encodeText(text, msg.parseMode), extra);
    return String(sent.message_id);
  }

  async edit(
    messageId: string,
    chatId: string,
    text?: string,
    markup?: ReplyMarkup,
    parseMode?: ParseMode,
  ): Promise<void> {
    const extra: Record<string, unknown> = {};
    const rm = replyMarkupToTelegram(markup);
    if (rm) extra.reply_markup = rm;
    if (parseMode && parseMode !== 'plain') extra.parse_mode = parseMode === 'markdown' ? 'MarkdownV2' : 'HTML';
    if (text !== undefined) {
      try {
        await this.bot.api.editMessageText(Number(chatId), Number(messageId), this.encodeText(text, parseMode), extra);
        return;
      } catch (err) {
        // "message is not modified" is benign — swallow.
        const msg = String((err as Error)?.message ?? '');
        if (msg.includes('message is not modified')) return;
        throw err;
      }
    } else if (markup) {
      await this.bot.api.editMessageReplyMarkup(Number(chatId), Number(messageId), extra);
    }
  }

  async delete(messageId: string, chatId: string): Promise<void> {
    await this.bot.api.deleteMessage(Number(chatId), Number(messageId));
  }

  async pin(messageId: string, chatId: string): Promise<void> {
    await this.bot.api.pinChatMessage(Number(chatId), Number(messageId), { disable_notification: true });
  }

  async setReaction(messageId: string, chatId: string, emoji: string | null): Promise<void> {
    // Grammy narrows `emoji` to Telegram's small whitelisted set of reaction
    // emoji; we accept any string per our platform-agnostic API. Cast through
    // to `ReactionType` is safe because the Bot API simply rejects unknown
    // emoji with 400 BAD_REQUEST — preferable to compiling an exhaustive
    // string-literal union on our side.
    const reaction = emoji
      ? ([{ type: 'emoji', emoji } as unknown as Parameters<typeof this.bot.api.setMessageReaction>[2][number]])
      : [];
    await this.bot.api.setMessageReaction(Number(chatId), Number(messageId), reaction);
  }

  async sendAttachment(
    chatId: string,
    attachment: OutboundAttachment | undefined,
    replyMarkup?: ReplyMarkup,
    threadId?: string,
  ): Promise<string> {
    if (!attachment) throw new Error('TelegramAdapter.sendAttachment: attachment required');
    return sendTelegramAttachment(this.bot, {
      chatId,
      attachment,
      caption: attachment.caption,
      threadId,
      replyMarkup: replyMarkupToTelegram(replyMarkup),
    });
  }

  async downloadAttachment(fileRef: string): Promise<Buffer> {
    return downloadTelegramFile(this.bot, fileRef);
  }

  onInbound(cb: (ev: InboundEvent) => void): () => void {
    this.inboundListeners.add(cb);
    return () => this.inboundListeners.delete(cb);
  }

  // ---- Internals ----------------------------------------------------------

  private buildExtra(
    markup: ReplyMarkup | undefined,
    parseMode: ParseMode | undefined,
    threadId: string | undefined,
    replyToMessageId: string | undefined,
    silent: boolean | undefined,
  ): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    const rm = replyMarkupToTelegram(markup);
    if (rm) extra.reply_markup = rm;
    if (parseMode && parseMode !== 'plain') extra.parse_mode = parseMode === 'markdown' ? 'MarkdownV2' : 'HTML';
    if (threadId) extra.message_thread_id = Number(threadId);
    if (replyToMessageId) extra.reply_to_message_id = Number(replyToMessageId);
    if (silent) extra.disable_notification = true;
    return extra;
  }

  private encodeText(text: string, parseMode: ParseMode | undefined): string {
    if (parseMode === 'markdown') return escapeMarkdownV2(text);
    return text;
  }

  private wireGrammyHandlers(): void {
    // Plain messages.
    this.bot.on('message:text', (ctx) => this.emitInbound(this.toInboundFromMessage(ctx, 'message')));
    this.bot.on('message:document', (ctx) => this.emitInbound(this.toInboundFromMessage(ctx, 'attachment')));
    this.bot.on('message:photo', (ctx) => this.emitInbound(this.toInboundFromMessage(ctx, 'attachment')));
    this.bot.on('callback_query:data', (ctx) => {
      const ev: InboundEvent = {
        channelType: 'telegram',
        chatId: String(ctx.chat?.id ?? ''),
        threadId: ctx.msg?.message_thread_id ? String(ctx.msg.message_thread_id) : undefined,
        messageId: String(ctx.msg?.message_id ?? ''),
        userId: String(ctx.from?.id ?? ''),
        username: ctx.from?.username,
        callbackData: ctx.callbackQuery.data,
        kind: 'callback',
        at: Date.now(),
      };
      this.emitInbound(ev);
      // Always answer the callback so the client stops spinning.
      void ctx.answerCallbackQuery().catch(() => { /* isolate */ });
    });
  }

  private toInboundFromMessage(ctx: Context, kind: 'message' | 'attachment'): InboundEvent {
    const msg = ctx.msg;
    const doc = msg?.document;
    const photo = msg?.photo?.[msg.photo.length - 1];
    const attachments: InboundEvent['attachments'] = [];
    if (doc) {
      attachments.push({
        name: doc.file_name ?? 'file',
        mime: doc.mime_type ?? 'application/octet-stream',
        fileRef: doc.file_id,
        sizeBytes: doc.file_size ?? 0,
      });
    }
    if (photo) {
      attachments.push({
        name: `photo-${photo.file_unique_id}.jpg`,
        mime: 'image/jpeg',
        fileRef: photo.file_id,
        sizeBytes: photo.file_size ?? 0,
      });
    }
    return {
      channelType: 'telegram',
      chatId: String(ctx.chat?.id ?? ''),
      threadId: msg?.message_thread_id ? String(msg.message_thread_id) : undefined,
      messageId: String(msg?.message_id ?? ''),
      userId: String(ctx.from?.id ?? ''),
      username: ctx.from?.username,
      text: msg?.text ?? msg?.caption,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyToMessageId: msg?.reply_to_message?.message_id ? String(msg.reply_to_message.message_id) : undefined,
      kind,
      at: Date.now(),
    };
  }

  private emitInbound(ev: InboundEvent): void {
    for (const l of this.inboundListeners) {
      try { l(ev); } catch { /* isolate */ }
    }
  }
}
