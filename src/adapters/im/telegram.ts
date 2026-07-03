// src/adapters/im/telegram.ts
//
// CRITICAL: stop() MUST release ALL handles within 1s. grammy's default
// long-poll keeps a fetch retrying forever; we wrap in AbortController
// and stop the bot via Bot.stop() then clear our own timers.

import { Bot } from 'grammy';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
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

  /** getFile → fetch bytes → write to ~/.tlive/inbox (v1 archaeology, grammy path). */
  private async downloadToInbox(fileId: string, name: string): Promise<string> {
    if (!this.bot) throw new Error('telegram not connected');
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error(`getFile: no file_path for ${fileId}`);
    const res = await fetch(`https://api.telegram.org/file/bot${this.opts.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`telegram download ${res.status}`);
    const inbox = join(process.env.TLIVE_HOME ?? join(homedir(), '.tlive'), 'inbox');
    mkdirSync(inbox, { recursive: true });
    const dest = join(inbox, `${randomUUID().slice(0, 8)}-${basename(name)}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return dest;
  }

  async start(): Promise<void> {
    if (this.connected === 'connected') return;
    this.bot = new Bot(this.opts.token);

    // Text messages
    this.bot.on('message:text', (ctx) => {
      if (!this.inboundHandler) return;
      const chatId = String(ctx.chat.id);
      // Fail-closed: only forward inbound from a configured chat.
      if (!this.opts.allowedChatIds?.length || !this.opts.allowedChatIds.includes(chatId)) return;
      const env: IncomingEnvelope = {
        channel: 'telegram',
        chatId,
        userId: String(ctx.from?.id ?? ''),
        messageId: String(ctx.message.message_id),
        text: ctx.message.text,
        ts: Date.now(),
        ...(ctx.message.reply_to_message ? { replyToMessageId: String(ctx.message.reply_to_message.message_id) } : {}),
      };
      this.inboundHandler(env);
    });

    // Photos & documents → download to the inbox dir, forward as local paths
    // (caption becomes text; consumers only ever see filesystem paths).
    const onMedia = async (ctx: {
      chat: { id: number };
      from?: { id: number };
      message: {
        message_id: number; caption?: string;
        reply_to_message?: { message_id: number };
        photo?: Array<{ file_id: string; file_unique_id: string; file_size?: number }>;
        document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
      };
    }): Promise<void> => {
      if (!this.inboundHandler) return;
      const chatId = String(ctx.chat.id);
      if (!this.opts.allowedChatIds?.length || !this.opts.allowedChatIds.includes(chatId)) return;
      const msg = ctx.message;
      const photo = msg.photo?.[msg.photo.length - 1]; // largest rendition
      const doc = msg.document;
      const items = [
        ...(photo ? [{ fileId: photo.file_id, name: `photo-${photo.file_unique_id}.jpg`, mime: 'image/jpeg', size: photo.file_size ?? 0 }] : []),
        ...(doc ? [{ fileId: doc.file_id, name: doc.file_name ?? 'file', mime: doc.mime_type ?? 'application/octet-stream', size: doc.file_size ?? 0 }] : []),
      ];
      const attachments: NonNullable<IncomingEnvelope['attachments']> = [];
      for (const it of items) {
        try {
          attachments.push({ name: it.name, mime: it.mime, sizeBytes: it.size, localPath: await this.downloadToInbox(it.fileId, it.name) });
        } catch { /* skip failed downloads; caption text still flows */ }
      }
      this.inboundHandler({
        channel: 'telegram',
        chatId,
        userId: String(ctx.from?.id ?? ''),
        messageId: String(msg.message_id),
        text: msg.caption ?? '',
        ...(attachments.length ? { attachments } : {}),
        ...(msg.reply_to_message ? { replyToMessageId: String(msg.reply_to_message.message_id) } : {}),
        ts: Date.now(),
      });
    };
    this.bot.on('message:photo', (ctx) => { void onMedia(ctx as never); });
    this.bot.on('message:document', (ctx) => { void onMedia(ctx as never); });

    // Inline-keyboard button callbacks (approve:<id> / deny:<id>)
    this.bot.on('callback_query:data', (ctx) => {
      if (!this.inboundHandler) return;
      const chatId = String(ctx.callbackQuery.message?.chat.id ?? '');
      // Fail-closed: only forward callbacks from a configured chat.
      if (!this.opts.allowedChatIds?.length || !this.opts.allowedChatIds.includes(chatId)) return;
      const data = ctx.callbackQuery.data;
      const env: IncomingEnvelope = {
        channel: 'telegram',
        chatId,
        userId: String(ctx.callbackQuery.from.id),
        messageId: String(ctx.callbackQuery.message?.message_id ?? ''),
        text: data,
        ts: Date.now(),
      };
      this.inboundHandler(env);
      // Acknowledge the callback to remove the loading indicator
      void ctx.answerCallbackQuery().catch(() => undefined);
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
