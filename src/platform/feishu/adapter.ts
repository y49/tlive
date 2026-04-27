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
  FormField,
} from '../types.js';
import type { ChannelType } from '../../workspace/bindings.js';
import { buildInlineCard } from './renderer.js';
import { buildFormCard } from './form.js';
import { sendFeishuAttachment, downloadFeishuAttachment } from './attachment.js';
import { Client as LarkClient, WSClient, EventDispatcher, Domain } from '@larksuiteoapi/node-sdk';
import type { Logger } from '../../util/logger.js';
import { larkLoggerAdapter } from './lark-logger.js';

export interface FeishuAdapterOptions {
  appId: string;
  appSecret: string;
  /** International edition. Default false → uses Domain.Feishu (China). */
  lark?: boolean;
  /** Daemon logger. WSClient log lines are routed to this. */
  logger?: Logger;
  /** Test-only: pre-built lark Client. Skips internal Client construction. */
  client?: unknown;
  /**
   * Test-only callback invoked to register event handlers. When provided,
   * the adapter does NOT construct WSClient/EventDispatcher and start()
   * /stop() become no-ops (caller manages lifecycle). When omitted (the
   * production path), the adapter constructs and owns both.
   */
  bindEventDispatcher?: (handlers: {
    onMessage: (payload: unknown) => void;
    onCardAction: (payload: unknown) => void;
  }) => void;
}

export class FeishuAdapter implements PlatformAdapter {
  readonly channelType: ChannelType = 'feishu';
  private readonly client: unknown;
  private readonly wsClient: { start(p: { eventDispatcher: unknown }): Promise<void>; close(p?: { force?: boolean }): void } | null;
  private readonly eventDispatcher: unknown | null;
  private readonly options: FeishuAdapterOptions;
  private readonly inboundListeners = new Set<(ev: InboundEvent) => void>();

  constructor(options: FeishuAdapterOptions) {
    this.options = options;

    // ---- Client (outbound REST) ----
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const domain = options.lark ? Domain.Lark : Domain.Feishu;
      this.client = new LarkClient({ appId: options.appId, appSecret: options.appSecret, domain });
    }

    // ---- Inbound dispatcher ----
    if (options.bindEventDispatcher) {
      // Test-injected: caller wires handlers via the callback; we do not own
      // a WSClient.
      this.wsClient = null;
      this.eventDispatcher = null;
      options.bindEventDispatcher({
        onMessage: (payload) => this.handleInboundMessage(payload),
        onCardAction: (payload) => this.handleCardAction(payload),
      });
    } else {
      const lg = options.logger ? larkLoggerAdapter(options.logger) : undefined;
      const dispatcher = new EventDispatcher({ logger: lg });
      dispatcher.register({
        'im.message.receive_v1': (payload: unknown) => this.handleInboundMessage(payload),
        'card.action.trigger':   (payload: unknown) => this.handleCardAction(payload),
      });
      this.eventDispatcher = dispatcher;
      this.wsClient = new WSClient({
        appId: options.appId,
        appSecret: options.appSecret,
        domain: options.lark ? Domain.Lark : Domain.Feishu,
        autoReconnect: true,
        logger: lg,
      }) as never;
    }
  }

  async start(): Promise<void> {
    if (!this.wsClient) return;
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    // Note: lark SDK's wsClient.start() resolves BEFORE the TCP handshake
    // (it kicks off reConnect(true) without await). The actual connection
    // state is exposed via wsConfig.getWSInstance().readyState — see
    // isConnected() below.
  }

  async stop(): Promise<void> {
    if (!this.wsClient) return;
    this.wsClient.close();
  }

  /**
   * Returns:
   *   true  — adapter owns a WSClient AND the underlying WebSocket is OPEN
   *           (readyState === 1). Accurate to the actual socket state, not
   *           just whether start() was called.
   *   false — adapter owns a WSClient but the WebSocket is not OPEN. This
   *           covers: pre-handshake (during start() race), CONNECTING (0),
   *           CLOSING (2), CLOSED (3), or wsConfig.getWSInstance() is null.
   *   null  — caller-injected lifecycle (test mode without WSClient); state
   *           unknown to adapter.
   */
  isConnected(): boolean | null {
    if (!this.wsClient) return null;
    // The lark SDK does not expose readyState in its TypeScript types, but
    // wsConfig.getWSInstance() is a stable runtime API used internally for
    // ping / reconnect logic. Cast through and read defensively — if the
    // SDK ever restructures, this falls back to false (treated as 'idle' by
    // doctor) rather than throwing.
    const ws = (this.wsClient as {
      wsConfig?: { getWSInstance?: () => { readyState?: number } | null };
    }).wsConfig?.getWSInstance?.();
    return ws?.readyState === 1;
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

  /**
   * Send a Feishu elicitation form card (interactive card with a `form`
   * element). Used by ElicitationFormRenderer for form-mode requests; the
   * generic `send` path goes through buildInlineCard which does not know
   * how to emit form elements.
   */
  async sendFormCard(
    chatId: string,
    spec: { title: string; fields: FormField[]; submitId: string; threadId?: string },
  ): Promise<string> {
    const card = buildFormCard(spec.title, spec.fields, spec.submitId);
    const content = JSON.stringify(card);
    const c = this.mustClient() as {
      im: { v1: { message: { create: (args: unknown) => Promise<{ data?: { message_id?: string } }> } } };
    };
    const res = await c.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content,
      },
    });
    return res.data?.message_id ?? '';
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
    // EventDispatcher.invoke calls RequestHandle.parse on the wire data
    // BEFORE handing to our handler, which flattens v2 payloads
    // (`{ ...rest, ...header, ...event }`). So `message` and `sender` are
    // at the TOP level of `payload`, not under `payload.event`.
    const p = payload as {
      message?: {
        message_id?: string;
        chat_id?: string;
        msg_type?: string;
        content?: string;
        parent_id?: string;
      };
      sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string };
    };
    const msg = p.message;
    if (!msg) return null;
    let text: string | undefined;
    if (msg.content) {
      try { text = (JSON.parse(msg.content) as { text?: string }).text; } catch { text = undefined; }
    }
    return {
      channelType: 'feishu',
      chatId: msg.chat_id ?? '',
      messageId: msg.message_id ?? '',
      userId: p.sender?.sender_id?.open_id ?? p.sender?.sender_id?.user_id ?? '',
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
