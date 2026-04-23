// src/platform/feishu/adapter.ts
//
// PlatformAdapter for Feishu / Lark. Uses @larksuiteoapi/node-sdk for REST and
// a pluggable event dispatcher (callers supply either WSClient or an
// adaptExpress webhook). We keep the Client loosely typed because lark's
// generated types are extensive; the shape we rely on is small.
//
// Feishu has no reaction API — setReaction throws, renderers are expected to
// consult CAPABILITIES and fall back via ReactionTracker's reply-message path.

import type {
  PlatformAdapter, OutboundMessage, OutboundAttachment, InboundEvent, ReplyMarkup,
} from '../types.js';
import type { ChannelType } from '../../workspace/bindings.js';
import { buildInlineCard } from './renderer.js';
import { sendFeishuAttachment, downloadFeishuAttachment } from './attachment.js';

export interface FeishuAdapterOptions {
  appId: string;
  appSecret: string;
  /** Inject a pre-built lark Client for tests. */
  client?: unknown;
  /**
   * Optional callback invoked to register event handlers. When omitted, the
   * adapter expects callers to wire events via `handleInboundMessage` /
   * `handleCardAction`, e.g. from an Express webhook.
   */
  bindEventDispatcher?: (handlers: {
    onMessage: (payload: unknown) => void;
    onCardAction: (payload: unknown) => void;
  }) => void;
}

export class FeishuAdapter implements PlatformAdapter {
  readonly channelType: ChannelType = 'feishu';
  private readonly client: unknown;
  private readonly inboundListeners = new Set<(ev: InboundEvent) => void>();
  private readonly options: FeishuAdapterOptions;

  constructor(options: FeishuAdapterOptions) {
    this.options = options;
    this.client = options.client ?? null;
    options.bindEventDispatcher?.({
      onMessage: (payload) => this.handleInboundMessage(payload),
      onCardAction: (payload) => this.handleCardAction(payload),
    });
  }

  async start(): Promise<void> {
    // With WSClient integrations the user is expected to have started the
    // connection before passing the client in; webhook adapters don't need
    // explicit start.
  }

  async stop(): Promise<void> {
    // Mirror start(). Concrete WSClient stop is caller-owned.
  }

  async send(msg: OutboundMessage): Promise<string> {
    if (msg.attachment) {
      return sendFeishuAttachment({ client: this.mustClient(), chatId: msg.chatId, attachment: { ...msg.attachment, caption: msg.text } });
    }
    const card = buildInlineCard(msg.text ?? '', msg.replyMarkup);
    const content = JSON.stringify(card);
    const c = this.mustClient() as {
      im: { v1: { message: { create: (args: unknown) => Promise<{ data?: { message_id?: string } }> } } };
    };
    const res = await c.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: msg.chatId,
        msg_type: 'interactive',
        content,
      },
    });
    return res.data?.message_id ?? '';
  }

  async edit(messageId: string, _chatId: string, text?: string, markup?: ReplyMarkup): Promise<void> {
    const card = buildInlineCard(text ?? '', markup);
    const c = this.mustClient() as {
      im: { v1: { message: { patch: (args: unknown) => Promise<unknown> } } };
    };
    await c.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  async delete(messageId: string, _chatId: string): Promise<void> {
    const c = this.mustClient() as {
      im: { v1: { message: { delete: (args: unknown) => Promise<unknown> } } };
    };
    await c.im.v1.message.delete({ path: { message_id: messageId } });
  }

  async pin(messageId: string, _chatId: string): Promise<void> {
    const c = this.mustClient() as {
      im: { v1: { pin: { create: (args: unknown) => Promise<unknown> } } };
    };
    await c.im.v1.pin.create({ data: { message_id: messageId } });
  }

  async setReaction(_messageId: string, _chatId: string, _emoji: string | null): Promise<void> {
    throw new Error('FeishuAdapter: native reactions unsupported — renderer must fall back');
  }

  async sendAttachment(
    chatId: string,
    attachment: OutboundAttachment | undefined,
    _replyMarkup?: ReplyMarkup,
    _threadId?: string,
  ): Promise<string> {
    if (!attachment) throw new Error('FeishuAdapter.sendAttachment: attachment required');
    return sendFeishuAttachment({ client: this.mustClient(), chatId, attachment });
  }

  async downloadAttachment(fileRef: string): Promise<Buffer> {
    return downloadFeishuAttachment(this.mustClient(), fileRef);
  }

  onInbound(cb: (ev: InboundEvent) => void): () => void {
    this.inboundListeners.add(cb);
    return () => this.inboundListeners.delete(cb);
  }

  // ---- Dispatch entry points (wired by webhook/ws) ------------------------

  handleInboundMessage(payload: unknown): void {
    const ev = this.parseMessageEvent(payload);
    if (ev) this.emitInbound(ev);
  }

  handleCardAction(payload: unknown): void {
    const ev = this.parseCardAction(payload);
    if (ev) this.emitInbound(ev);
  }

  // ---- Internals ----------------------------------------------------------

  private parseMessageEvent(payload: unknown): InboundEvent | null {
    const p = payload as {
      event?: {
        message?: {
          message_id?: string;
          chat_id?: string;
          msg_type?: string;
          content?: string;
          parent_id?: string;
        };
        sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string };
      };
    };
    const msg = p.event?.message;
    if (!msg) return null;
    let text: string | undefined;
    if (msg.content) {
      try { text = (JSON.parse(msg.content) as { text?: string }).text; } catch { text = undefined; }
    }
    return {
      channelType: 'feishu',
      chatId: msg.chat_id ?? '',
      messageId: msg.message_id ?? '',
      userId: p.event?.sender?.sender_id?.open_id ?? p.event?.sender?.sender_id?.user_id ?? '',
      text,
      replyToMessageId: msg.parent_id,
      kind: 'message',
      at: Date.now(),
    };
  }

  private parseCardAction(payload: unknown): InboundEvent | null {
    const p = payload as {
      action?: { value?: { callback_data?: string } };
      form_value?: Record<string, string>;
      operator?: { open_id?: string; user_id?: string };
      open_message_id?: string;
      open_chat_id?: string;
    };
    const userId = p.operator?.open_id ?? p.operator?.user_id ?? '';
    const callbackData = p.action?.value?.callback_data;
    const formValues = p.form_value;
    if (formValues && Object.keys(formValues).length > 0) {
      return {
        channelType: 'feishu',
        chatId: p.open_chat_id ?? '',
        messageId: p.open_message_id ?? '',
        userId,
        callbackData,
        formValues,
        kind: 'form_submit',
        at: Date.now(),
      };
    }
    if (!callbackData) return null;
    return {
      channelType: 'feishu',
      chatId: p.open_chat_id ?? '',
      messageId: p.open_message_id ?? '',
      userId,
      callbackData,
      kind: 'callback',
      at: Date.now(),
    };
  }

  private mustClient(): unknown {
    if (!this.client) throw new Error('FeishuAdapter: client not configured');
    return this.client;
  }

  private emitInbound(ev: InboundEvent): void {
    for (const l of this.inboundListeners) {
      try { l(ev); } catch { /* isolate */ }
    }
  }
}
