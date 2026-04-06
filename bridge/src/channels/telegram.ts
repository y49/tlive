import { Bot, InputFile, type Api, type RawApi } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { createServer, type Server } from 'node:http';
import { BaseChannelAdapter, registerAdapterFactory } from './base.js';
import type { InboundMessage, OutboundMessage, SendResult, FileAttachment } from './types.js';
import { loadConfig } from '../config.js';
import { createNodeAgent, maskProxyUrl } from '../proxy.js';
import { chunkMarkdown } from '../delivery/delivery.js';
import { classifyError } from './errors.js';

interface TelegramConfig {
  botToken: string;
  chatId: string;
  allowedUsers: string[];
  requireMention: boolean;
  webhookUrl: string;
  webhookSecret: string;
  webhookPort: number;
  disableLinkPreview: boolean;
  proxy: string;
}

/** Pending pairing requests: code → { userId, chatId, expiresAt } */
interface PairingRequest {
  userId: string;
  chatId: string;
  username: string;
  expiresAt: number;
}

export class TelegramAdapter extends BaseChannelAdapter {
  readonly channelType = 'telegram' as const;
  private bot: Bot | null = null;
  private config: TelegramConfig;
  private messageQueue: InboundMessage[] = [];
  private botUsername = '';
  private webhookServer: Server | null = null;
  private runnerHandle: RunnerHandle | null = null;
  /** Pairing mode: pending codes waiting for approval */
  private pendingPairings = new Map<string, PairingRequest>();
  /** Pairing mode: approved user IDs (runtime, in addition to config.allowedUsers) */
  private approvedUsers = new Set<string>();

  constructor(config: TelegramConfig) {
    super();
    this.config = config;
  }

  /** Build Telegram file download URL from file path */
  private fileUrl(filePath: string): string {
    return `https://api.telegram.org/file/bot${this.config.botToken}/${filePath}`;
  }

  async start(): Promise<void> {
    const agent = createNodeAgent(this.config.proxy);
    this.bot = new Bot(this.config.botToken, agent
      ? { client: { baseFetchConfig: { agent, compress: true } } }
      : {});

    if (this.config.proxy) {
      console.log(`[telegram] Using proxy: ${maskProxyUrl(this.config.proxy)}`);
    }

    // Install API throttler (rate-limit protection)
    this.bot.api.config.use(apiThrottler());

    // Probe bot capabilities on startup
    try {
      const me = await this.bot.api.getMe();
      this.botUsername = me.username ?? '';
      console.log(`[telegram] Bot ready: @${me.username} (id: ${me.id})`);
      if (!(me as any).can_read_all_group_messages) {
        console.warn('[telegram] ⚠ Bot does not have "Group Privacy" disabled — it may not receive group messages. Disable via @BotFather → /setprivacy');
      }
      // Register native commands to BotFather menu
      await this.bot.api.setMyCommands([
        { command: 'new', description: 'New conversation' },
        { command: 'sessions', description: 'List recent sessions' },
        { command: 'session', description: 'Switch to session #n' },
        { command: 'verbose', description: 'Set detail level (0/1)' },
        { command: 'model', description: 'Switch model' },
        { command: 'runtime', description: 'Switch provider (claude/codex)' },
        { command: 'settings', description: 'Settings scope (user/full/isolated)' },
        { command: 'perm', description: 'Permission prompts (on/off)' },
        { command: 'effort', description: 'Thinking depth (low/high/max)' },
        { command: 'stop', description: 'Interrupt execution' },
        { command: 'status', description: 'Bridge status' },
        { command: 'hooks', description: 'Pause/resume IM approval' },
        { command: 'help', description: 'Show all commands' },
      ]);
      console.log('[telegram] Registered bot commands to menu');
    } catch (err) {
      console.error(`[telegram] ⚠ Failed to verify bot: ${err}. Check TL_TG_BOT_TOKEN.`);
    }

    // Register message handler
    this.bot.on('message', async (ctx) => {
      const msg = ctx.message;
      const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
      let text = msg.text ?? msg.caption ?? '';

      // Group @mention filtering
      if (isGroup && this.config.requireMention && text && !msg.reply_to_message) {
        const mentionPattern = new RegExp(`@${this.botUsername}\\b`, 'i');
        if (!mentionPattern.test(text)) return;
        text = text.replace(mentionPattern, '').trim();
      }

      const base = {
        channelType: 'telegram' as const,
        chatId: String(msg.chat.id),
        userId: String(msg.from?.id ?? ''),
        text,
        messageId: String(msg.message_id),
        replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
        threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
      };

      const attachments: FileAttachment[] = [];

      if (msg.photo?.length) {
        const photo = msg.photo[msg.photo.length - 1];
        try {
          const file = await this.bot!.api.getFile(photo.file_id);
          if (file.file_path) {
            const resp = await fetch(this.fileUrl(file.file_path));
            if (resp.ok) {
              const buf = Buffer.from(await resp.arrayBuffer());
              if (buf.length <= 10_000_000) {
                attachments.push({
                  type: 'image', name: 'photo.jpg',
                  mimeType: 'image/jpeg', base64Data: buf.toString('base64'),
                });
              }
            }
          }
        } catch { /* skip */ }
      }

      if (msg.document) {
        try {
          const file = await this.bot!.api.getFile(msg.document.file_id);
          if (file.file_path) {
            const resp = await fetch(this.fileUrl(file.file_path));
            if (resp.ok) {
              const buf = Buffer.from(await resp.arrayBuffer());
              if (buf.length <= 10_000_000) {
                const mimeType = msg.document.mime_type ?? 'application/octet-stream';
                attachments.push({
                  type: mimeType.startsWith('image/') ? 'image' : 'file',
                  name: msg.document.file_name ?? 'file',
                  mimeType, base64Data: buf.toString('base64'),
                });
              }
            }
          }
        } catch { /* skip */ }
      }

      if (!base.text && attachments.length === 0) return;
      this.messageQueue.push({ ...base, attachments: attachments.length > 0 ? attachments : undefined });
    });

    // Reaction notifications
    this.bot.on('message_reaction', (ctx) => {
      const reaction = ctx.messageReaction;
      if (!reaction?.new_reaction?.length) return;
      const userId = String((reaction as any).user?.id ?? (reaction as any).actor_chat?.id ?? '');
      const chatId = String(reaction.chat.id);
      const msgId = String(reaction.message_id);
      const emojis = reaction.new_reaction
        .map((r: any) => r.emoji || r.custom_emoji_id || '')
        .filter(Boolean)
        .join(' ');
      if (!emojis) return;
      this.messageQueue.push({
        channelType: 'telegram',
        chatId, userId,
        text: `[reaction: ${emojis}]`,
        messageId: msgId,
        replyToMessageId: msgId,
      });
    });

    // Callback query handler
    this.bot.on('callback_query:data', async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      this.messageQueue.push({
        channelType: 'telegram',
        chatId: String(ctx.callbackQuery.message?.chat.id ?? ''),
        userId: String(ctx.callbackQuery.from.id),
        text: '',
        callbackData: ctx.callbackQuery.data,
        messageId: String(ctx.callbackQuery.message?.message_id ?? ''),
      });
    });

    // Start: webhook or long-polling via runner
    const useWebhook = !!this.config.webhookUrl;
    if (useWebhook) {
      await this.bot.api.setWebhook(this.config.webhookUrl, {
        secret_token: this.config.webhookSecret || undefined,
        allowed_updates: ['message', 'callback_query', 'message_reaction'],
      });

      const webhookPath = '/telegram-webhook';
      this.webhookServer = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== webhookPath) {
          res.writeHead(404); res.end(); return;
        }
        if (this.config.webhookSecret) {
          if (req.headers['x-telegram-bot-api-secret-token'] !== this.config.webhookSecret) {
            res.writeHead(403); res.end(); return;
          }
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try { this.bot!.handleUpdate(JSON.parse(body)); }
          catch { /* ignore */ }
          res.writeHead(200); res.end('OK');
        });
      });

      const port = this.config.webhookPort || 8443;
      this.webhookServer.listen(port, () => {
        console.log(`[telegram] Webhook server listening on port ${port}`);
      });
    } else {
      // Use grammY runner for robust long-polling (sequential per-chat, concurrent overall)
      await this.bot.api.deleteWebhook();
      this.runnerHandle = run(this.bot, {
        runner: {
          fetch: {
            allowed_updates: ['message', 'callback_query', 'message_reaction'],
          },
        },
      });
      console.log('[telegram] Long-polling started via grammY runner');
    }
  }

  async stop(): Promise<void> {
    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = null;
      try { await this.bot?.api.deleteWebhook(); } catch { /* best effort */ }
    }
    if (this.runnerHandle) {
      this.runnerHandle.stop();
      this.runnerHandle = null;
    }
    this.bot = null;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.messageQueue.shift() ?? null;
  }

  private get api(): Api<RawApi> {
    if (!this.bot) throw new Error('Telegram bot not started');
    return this.bot.api;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const api = this.api;

    // General topic (thread_id=1): Telegram rejects message_thread_id=1
    const threadId = (message.threadId && message.threadId !== '1')
      ? parseInt(message.threadId, 10) : undefined;

    // Media sending
    if (message.media) {
      try {
        const media = message.media;
        let source: InputFile | string;
        if (media.buffer) {
          source = new InputFile(media.buffer, media.filename || 'file');
        } else if (media.url?.startsWith('data:')) {
          const base64 = media.url.split(',')[1];
          source = new InputFile(Buffer.from(base64, 'base64'), media.filename || 'file');
        } else if (media.url) {
          source = media.url;
        } else {
          throw new Error('No media source');
        }

        if (media.type === 'image') {
          const result = await api.sendPhoto(message.chatId, source, {
            caption: message.html ?? message.text,
            parse_mode: message.html ? 'HTML' : undefined,
            message_thread_id: threadId,
          });
          return { messageId: String(result.message_id), success: true };
        } else {
          const result = await api.sendDocument(message.chatId, source, {
            caption: message.text,
            message_thread_id: threadId,
          });
          return { messageId: String(result.message_id), success: true };
        }
      } catch (err) {
        if (!message.text && !message.html) throw classifyError('telegram', err);
      }
    }

    const text = message.html ?? message.text ?? '';
    const chunks = text.length > 4096 ? chunkMarkdown(text, 4096) : [text];

    let lastMessageId = '';
    try {
      for (let i = 0; i < chunks.length; i++) {
        const opts: Record<string, unknown> = {
          parse_mode: message.html ? 'HTML' : undefined,
          message_thread_id: threadId,
        };

        if (this.config.disableLinkPreview) {
          opts.link_preview_options = { is_disabled: true };
        }

        if (message.replyToMessageId && i === 0) {
          opts.reply_to_message_id = parseInt(message.replyToMessageId, 10);
        }

        // Buttons on last chunk only
        if (i === chunks.length - 1 && message.buttons?.length) {
          opts.reply_markup = {
            inline_keyboard: [message.buttons.map(b => {
              if (b.url) {
                return { text: b.label, url: b.url };
              }
              return { text: b.label, callback_data: b.callbackData };
            })],
          };
        }

        try {
          const result = await api.sendMessage(message.chatId, chunks[i], opts);
          lastMessageId = String(result.message_id);
        } catch (sendErr: any) {
          // Parse-mode fallback: retry without HTML if formatting fails
          if (opts.parse_mode && sendErr?.error_code === 400) {
            delete opts.parse_mode;
            const result = await api.sendMessage(message.chatId, chunks[i], opts);
            lastMessageId = String(result.message_id);
          } else {
            throw sendErr;
          }
        }
      }
    } catch (err) {
      throw classifyError('telegram', err);
    }

    return { messageId: lastMessageId, success: true };
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.api.deleteMessage(chatId, parseInt(messageId, 10));
    } catch {
      // Non-fatal
    }
  }

  async editMessage(chatId: string, messageId: string, message: OutboundMessage): Promise<void> {
    if (!this.bot) return;
    const text = message.html ?? message.text ?? '';
    const opts: Record<string, unknown> = {
      parse_mode: message.html ? 'HTML' : undefined,
    };
    if (message.buttons?.length) {
      // Group buttons by row field; buttons without row go in one default row
      const hasRows = message.buttons.some(b => b.row !== undefined);
      let rows: Array<typeof message.buttons>;
      if (hasRows) {
        const rowMap = new Map<number, typeof message.buttons>();
        for (const b of message.buttons) {
          const r = b.row ?? Number.MAX_SAFE_INTEGER;
          if (!rowMap.has(r)) rowMap.set(r, []);
          rowMap.get(r)!.push(b);
        }
        rows = [...rowMap.entries()].sort(([a], [b]) => a - b).map(([, btns]) => btns);
      } else {
        rows = [message.buttons];
      }
      opts.reply_markup = {
        inline_keyboard: rows.map(row => row.map(b => {
          if (b.url) return { text: b.label, url: b.url };
          return { text: b.label, callback_data: b.callbackData };
        })),
      };
    } else if (message.buttons) {
      // Empty array = clear existing buttons
      opts.reply_markup = { inline_keyboard: [] };
    }
    try {
      await this.api.editMessageText(chatId, parseInt(messageId, 10), text, opts);
    } catch (err: unknown) {
      if (err instanceof Error && err.message?.includes('message is not modified')) return;

      const classified = classifyError('telegram', err);

      // 429 Rate limit: wait retry_after and retry once
      if (classified.retryable && 'retryAfterMs' in classified) {
        const delay = Math.min((classified as any).retryAfterMs || 1000, 30_000);
        await new Promise(r => setTimeout(r, delay));
        try {
          await this.api.editMessageText(chatId, parseInt(messageId, 10), text, opts);
          return;
        } catch {
          // give up — next flush will catch up
        }
      }

      // 400 Format error: retry without HTML (same pattern as sendMessage)
      if (!classified.retryable && opts.parse_mode) {
        try {
          delete opts.parse_mode;
          await this.api.editMessageText(chatId, parseInt(messageId, 10), text, opts);
          return;
        } catch {
          // give up
        }
      }

      // Streaming edits are non-fatal: log and swallow so the bridge stays alive
      console.warn(`[telegram] editMessage failed (${classified.constructor.name}): ${classified.message}`);
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try { await this.bot?.api.sendChatAction(chatId, 'typing'); }
    catch { /* non-critical */ }
  }

  async addReaction(_chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.api.setMessageReaction(_chatId, parseInt(messageId, 10), [{ type: 'emoji', emoji } as any]);
    } catch { /* non-fatal */ }
  }

  async removeReaction(_chatId: string, messageId: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.api.setMessageReaction(_chatId, parseInt(messageId, 10), []);
    } catch { /* non-fatal */ }
  }

  validateConfig(): string | null {
    if (!this.config.botToken) return 'TL_TG_BOT_TOKEN is required for Telegram';
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    if (this.config.allowedUsers.length > 0) {
      return this.config.allowedUsers.includes(userId) || this.approvedUsers.has(userId);
    }
    return this.approvedUsers.has(userId);
  }

  requestPairing(userId: string, chatId: string, username: string): string | null {
    // Clean up expired entries
    for (const [code, req] of this.pendingPairings) {
      if (Date.now() >= req.expiresAt) this.pendingPairings.delete(code);
    }
    // Check existing request for this user
    for (const [code, req] of this.pendingPairings) {
      if (req.userId === userId) return code;
    }
    // Global limit
    if (this.pendingPairings.size >= 50) {
      console.warn('[telegram] Pairing limit reached (50 pending)');
      return null;
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.pendingPairings.set(code, {
      userId, chatId, username,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    return code;
  }

  approvePairing(code: string): { userId: string; username: string } | null {
    const req = this.pendingPairings.get(code);
    if (!req || Date.now() >= req.expiresAt) {
      if (req) this.pendingPairings.delete(code);
      return null;
    }
    this.approvedUsers.add(req.userId);
    this.pendingPairings.delete(code);
    console.log(`[telegram] Approved pairing for user ${req.username} (${req.userId})`);
    this.bot?.api.sendMessage(req.chatId, '✅ Pairing approved! You can now send messages.').catch(() => {});
    return { userId: req.userId, username: req.username };
  }

  listPairings(): Array<{ code: string; userId: string; username: string }> {
    const result: Array<{ code: string; userId: string; username: string }> = [];
    for (const [code, req] of this.pendingPairings) {
      if (Date.now() >= req.expiresAt) { this.pendingPairings.delete(code); continue; }
      result.push({ code, userId: req.userId, username: req.username });
    }
    return result;
  }
}

// Self-register
registerAdapterFactory('telegram', () => new TelegramAdapter(loadConfig().telegram));
