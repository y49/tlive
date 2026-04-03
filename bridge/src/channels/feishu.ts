import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { BaseChannelAdapter, registerAdapterFactory } from './base.js';
import type { InboundMessage, OutboundMessage, SendResult, FileAttachment } from './types.js';
import { loadConfig } from '../config.js';
import { classifyError } from './errors.js';
import { markdownToFeishu, downgradeHeadings } from '../markdown/feishu.js';
import { buildFeishuCard } from '../formatting/feishu-card.js';
import { FeishuStreamingSession } from './feishu-streaming.js';
import { Readable } from 'node:stream';

/**
 * Read a Feishu SDK response into a Buffer.
 * The SDK returns different formats depending on version/endpoint:
 * Buffer, ArrayBuffer, async iterable, or nested in .data
 * (Inspired by openclaw's readFeishuResponseBuffer)
 */
async function readFeishuBuffer(resp: unknown): Promise<Buffer | null> {
  if (!resp) return null;
  const r = resp as any;
  // Direct Buffer
  if (Buffer.isBuffer(r)) return r;
  if (r instanceof ArrayBuffer) return Buffer.from(r);
  // Nested in .data
  if (r.data && Buffer.isBuffer(r.data)) return r.data;
  if (r.data instanceof ArrayBuffer) return Buffer.from(r.data);
  // getReadableStream() — SDK v1.30+ returns this for file downloads
  if (typeof r.getReadableStream === 'function') {
    const stream = r.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  // writeFile() — SDK fallback: write to temp file then read back
  if (typeof r.writeFile === 'function') {
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { readFile, unlink } = await import('node:fs/promises');
    const tmp = join(tmpdir(), `tlive-feishu-${Date.now()}.tmp`);
    try {
      await r.writeFile(tmp);
      return await readFile(tmp);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  // Async iterable (stream) on .data
  if (typeof r.data?.[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of r.data as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof r[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of r as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  // Readable stream on .data
  if (typeof r.data?.read === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of r.data as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return null;
}

/** Feishu interactive card element – now imported from shared types */
type FeishuCardElement = import('../formatting/types.js').FeishuCardElement;

/** Shape of the Feishu message.create API response */
interface FeishuCreateMessageResult {
  code?: number;
  msg?: string;
  data?: { message_id?: string };
}

interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  webhookPort: number;
  allowedUsers: string[];
}

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu' as const;
  private client: Client | null = null;
  private wsClient: WSClient | null = null;
  private config: FeishuConfig;
  private messageQueue: InboundMessage[] = [];

  constructor(config: FeishuConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    this.client = new Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    const eventDispatcher = new EventDispatcher({
      verificationToken: this.config.verificationToken,
      encryptKey: this.config.encryptKey,
    });

    eventDispatcher.register({
      'im.message.receive_v1': async (event: { sender?: { sender_id?: { user_id?: string; open_id?: string; union_id?: string } }; message?: { message_type?: string; content: string; chat_id: string; message_id: string; parent_id?: string; root_id?: string } }) => {
        const msg = event?.message;
        if (!msg) return;

        const senderId = event?.sender?.sender_id;
        // Use user_id as primary identifier; store open_id as fallback for auth matching
        const userId = senderId?.user_id || senderId?.open_id || '';
        const attachments: FileAttachment[] = [];

        if (msg.message_type === 'text') {
          let text = '';
          try {
            const content = JSON.parse(msg.content);
            text = content.text ?? '';
            // Strip @mention placeholders (e.g. "@_user_1 ") from group chat messages
            text = text.replace(/@_user_\d+\s*/g, '').trim();
          } catch {
            return;
          }

          this.messageQueue.push({
            channelType: 'feishu',
            chatId: msg.chat_id,
            userId,

            text,
            messageId: msg.message_id,
            replyToMessageId: msg.parent_id || msg.root_id || undefined,
          });
        } else if (msg.message_type === 'image') {
          try {
            const imageKey = JSON.parse(msg.content).image_key;
            let buf: Buffer | null = null;
            try {
              buf = await readFeishuBuffer(await this.client!.im.messageResource.get({
                path: { message_id: msg.message_id, file_key: imageKey },
                params: { type: 'image' },
              }));
            } catch {
              try {
                buf = await readFeishuBuffer(await this.client!.im.image.get({
                  path: { image_key: imageKey },
                }));
              } catch { /* both methods failed */ }
            }
            if (buf && buf.length > 0 && buf.length <= 10_000_000) {
              attachments.push({
                type: 'image', name: 'image.png',
                mimeType: 'image/png', base64Data: buf.toString('base64'),
              });
            }
          } catch { /* skip undownloadable images */ }

          if (attachments.length > 0) {
            this.messageQueue.push({
              channelType: 'feishu',
              chatId: msg.chat_id,
              userId,
  
              text: '',
              messageId: msg.message_id,
              replyToMessageId: msg.parent_id || msg.root_id || undefined,
              attachments,
            });
          }
        } else if (msg.message_type === 'file') {
          try {
            const fileKey = JSON.parse(msg.content).file_key;
            const resp = await this.client!.im.v1.messageResource.get({
              path: { message_id: msg.message_id, file_key: fileKey },
              params: { type: 'file' },
            });
            if ((resp as any)?.data) {
              const chunks: Buffer[] = [];
              for await (const chunk of (resp as any).data as AsyncIterable<Buffer>) {
                chunks.push(chunk);
              }
              const buf = Buffer.concat(chunks);
              if (buf.length <= 10_000_000) {
                attachments.push({
                  type: 'file', name: 'file',
                  mimeType: 'application/octet-stream', base64Data: buf.toString('base64'),
                });
              }
            }
          } catch { /* skip undownloadable files */ }

          if (attachments.length > 0) {
            this.messageQueue.push({
              channelType: 'feishu',
              chatId: msg.chat_id,
              userId,
  
              text: '',
              messageId: msg.message_id,
              replyToMessageId: msg.parent_id || msg.root_id || undefined,
              attachments,
            });
          }
        }
      },
    });

    // Register card action handler for button callbacks (schema 2.0 cards)
    eventDispatcher.register({
      'card.action.trigger': async (data: unknown) => {
        console.log('[feishu] card.action.trigger received:', JSON.stringify(data).slice(0, 300));
        const event = data as { operator?: { user_id?: string; open_id?: string }; action?: { value?: Record<string, string> }; context?: { chat_id?: string; open_message_id?: string } };
        const action = event?.action?.value?.action;
        if (!action) { console.warn('[feishu] card.action.trigger: no action value found'); return; }
        const userId = event?.operator?.user_id || event?.operator?.open_id || '';
        const chatId = event?.context?.chat_id || '';
        const messageId = event?.context?.open_message_id || '';
        this.messageQueue.push({
          channelType: 'feishu',
          chatId,
          userId,
          text: '',
          callbackData: action,
          messageId,
        });
      },
    } as any);

    // Use WebSocket long connection (no public callback URL needed)
    this.wsClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    await this.wsClient.start({ eventDispatcher });
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      try { (this.wsClient as any).close?.(); } catch { /* best effort */ }
      this.wsClient = null;
    }
    this.client = null;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.messageQueue.shift() ?? null;
  }

  private buildCard(text: string, buttons?: OutboundMessage['buttons'], header?: { template: string; title: string }): string {
    const elements: FeishuCardElement[] = [
      { tag: 'markdown', content: downgradeHeadings(text) },
    ];

    if (buttons?.length) {
      // Group buttons by row; each group becomes a column_set
      const hasRows = buttons.some(b => b.row !== undefined);
      const makeBtn = (btn: NonNullable<OutboundMessage['buttons']>[0]) => ({
        tag: 'column' as const,
        width: 'auto' as const,
        vertical_align: 'top' as const,
        elements: [{
          tag: 'button' as const,
          text: { tag: 'plain_text' as const, content: btn.label },
          type: btn.style === 'danger' ? 'danger' as const : btn.style === 'primary' ? 'primary_filled' as const : 'default' as const,
          behaviors: [{ type: 'callback' as const, value: { action: btn.callbackData } }],
        }],
      });
      if (hasRows) {
        const rowMap = new Map<number, typeof buttons>();
        for (const b of buttons) {
          const r = b.row ?? Number.MAX_SAFE_INTEGER;
          if (!rowMap.has(r)) rowMap.set(r, []);
          rowMap.get(r)!.push(b);
        }
        for (const [, rowBtns] of [...rowMap.entries()].sort(([a], [b]) => a - b)) {
          elements.push({
            tag: 'column_set', flex_mode: 'flow',
            columns: rowBtns.map(makeBtn),
          } as any);
        }
      } else {
        elements.push({
          tag: 'column_set', flex_mode: 'flow',
          columns: buttons.map(makeBtn),
        } as any);
      }
    }

    return buildFeishuCard({
      header: header as any,
      elements,
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.client) throw new Error('Feishu client not started');

    // Prefer raw text (markdown) over HTML — schema 2.0 cards render markdown natively
    const raw = message.text
      ? message.text
      : markdownToFeishu(message.html ?? '');

    // Media sending
    if (message.media) {
      try {
        const media = message.media;
        let buffer: Buffer;
        if (media.buffer) {
          buffer = media.buffer;
        } else if (media.url?.startsWith('data:')) {
          const base64 = media.url.split(',')[1];
          buffer = Buffer.from(base64, 'base64');
        } else if (media.url) {
          // Fetch URL to buffer
          const resp = await fetch(media.url);
          buffer = Buffer.from(await resp.arrayBuffer());
        } else {
          throw new Error('No media source');
        }

        if (media.type === 'image') {
          // Upload image first, then send
          // Pass Buffer directly — Readable.from() causes form-data issues
          // See: https://github.com/larksuite/node-sdk/issues/121
          const uploadResult = await this.client.im.image.create({
            data: {
              image_type: 'message',
              image: buffer as any,
            },
          });
          const imageKey = (uploadResult as any)?.data?.image_key;
          if (imageKey) {
            const idType = message.receiveIdType || 'chat_id';
            const result = await this.client.im.message.create({
              params: { receive_id_type: idType as any },
              data: {
                receive_id: message.chatId,
                msg_type: 'image',
                content: JSON.stringify({ image_key: imageKey }),
              },
            });
            const messageId = (result as any)?.data?.message_id ?? '';
            return { messageId: String(messageId), success: true };
          }
        } else {
          // Upload file then send
          // Pass Buffer directly — Readable.from() causes form-data issues
          const uploadResult = await this.client.im.file.create({
            data: {
              file_type: 'stream',
              file_name: media.filename || 'file',
              file: buffer as any,
            },
          });
          const fileKey = (uploadResult as any)?.data?.file_key;
          if (fileKey) {
            const idType = message.receiveIdType || 'chat_id';
            const result = await this.client.im.message.create({
              params: { receive_id_type: idType as any },
              data: {
                receive_id: message.chatId,
                msg_type: 'file',
                content: JSON.stringify({ file_key: fileKey }),
              },
            });
            const messageId = (result as any)?.data?.message_id ?? '';
            return { messageId: String(messageId), success: true };
          }
        }
      } catch (err) {
        // Fall through to text-only if media fails
        if (!message.text && !message.html) throw classifyError('feishu', err);
      }
    }

    try {
      const idType = message.receiveIdType || 'chat_id';
      // If feishuElements provided, build card directly from structured elements
      const cardContent = message.feishuElements
        ? buildFeishuCard({ header: message.feishuHeader as any, elements: message.feishuElements as any })
        : this.buildCard(raw, message.buttons, message.feishuHeader);
      const data: Record<string, unknown> = {
        receive_id: message.chatId,
        msg_type: 'interactive',
        content: cardContent,
      };
      if (message.replyToMessageId) data.root_id = message.replyToMessageId;

      let result: FeishuCreateMessageResult;
      try {
        result = await this.client.im.message.create({
          params: { receive_id_type: idType as any },
          data: data as any,
        }) as FeishuCreateMessageResult;
      } catch (createErr) {
        // Reply target withdrawn/deleted — retry without root_id
        const code = (createErr as any)?.code;
        if (message.replyToMessageId && (code === 230011 || code === 231003)) {
          delete data.root_id;
          result = await this.client.im.message.create({
            params: { receive_id_type: idType as any },
            data: data as any,
          }) as FeishuCreateMessageResult;
        } else {
          throw createErr;
        }
      }

      const messageId = result?.data?.message_id ?? '';
      return { messageId: String(messageId), success: true };
    } catch (err) {
      throw classifyError('feishu', err);
    }
  }

  async deleteMessage(_chatId: string, messageId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.im.message.delete({ path: { message_id: messageId } });
    } catch {
      // Non-fatal
    }
  }

  async editMessage(_chatId: string, messageId: string, message: OutboundMessage): Promise<void> {
    if (!this.client) return;
    const text = message.text
      ? message.text
      : markdownToFeishu(message.html ?? '');

    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: this.buildCard(text, message.buttons, message.feishuHeader),
        },
      });
    } catch (err: any) {
      console.warn(`[feishu] editMessage failed: ${err?.message ?? err}`);
    }
  }

  createStreamingSession(chatId: string, receiveIdType?: string, replyToMessageId?: string, header?: { template: string; title: string }): FeishuStreamingSession | null {
    if (!this.client) return null;
    return new FeishuStreamingSession({
      client: this.client,
      chatId,
      receiveIdType,
      replyToMessageId,
      header,
    });
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Feishu has no native typing API; reactions are used instead
    // (handled by bridge-manager via addReaction)
  }

  private reactionIds = new Map<string, string>();

  async addReaction(_chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;
    try {
      // Remove existing reaction first (if any)
      await this.removeReaction(_chatId, messageId);
      const result = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      const reactionId = (result as any)?.data?.reaction_id;
      if (reactionId) this.reactionIds.set(messageId, reactionId);
    } catch { /* non-fatal */ }
  }

  async removeReaction(_chatId: string, messageId: string): Promise<void> {
    if (!this.client) return;
    const reactionId = this.reactionIds.get(messageId);
    if (!reactionId) return;
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
      this.reactionIds.delete(messageId);
    } catch {
      // Non-fatal
    }
  }

  validateConfig(): string | null {
    if (!this.config.appId) return 'TL_FS_APP_ID is required for Feishu';
    if (!this.config.appSecret) return 'TL_FS_APP_SECRET is required for Feishu';
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    if (this.config.allowedUsers.length === 0) return true;
    // userId may be user_id or open_id — match against either format in allowedUsers
    return this.config.allowedUsers.includes(userId);
  }
}

// Self-register
registerAdapterFactory('feishu', () => new FeishuAdapter(loadConfig().feishu));
