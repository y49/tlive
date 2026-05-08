// src/platform/feishu/adapter.ts
//
// PlatformAdapter for Feishu / Lark. Uses @larksuiteoapi/node-sdk for REST and
// a pluggable event dispatcher (callers supply either WSClient or an
// adaptExpress webhook). We keep the Client loosely typed because lark's
// generated types are extensive; the shape we rely on is small.
//
// setReaction is implemented via POST/DELETE /open-apis/im/v1/messages/{id}/reactions.
// HTTP calls are injected via options.httpPost / options.httpDelete (Approach A)
// so tests can mock them without touching the lark SDK Client. Production uses
// thin wrappers around the lark Client's im.v1.messageReaction.create/delete
// methods (camelCase singular — verified by inspecting Object.keys(c.im.v1)).
// Reaction errors are always swallowed.

import type {
  PlatformAdapter, OutboundMessage, OutboundAttachment, InboundEvent, ReplyMarkup,
  FormField,
} from '../types.js';
import { RateLimitError } from '../types.js';
import type { ChannelType } from '../../workspace/chat-instance.js';
import { buildInlineCard } from './renderer.js';
import { buildFormCard } from './form.js';
import { sendFeishuAttachment, downloadFeishuAttachment } from './attachment.js';
import { feishuEmojiType } from './emoji-map.js';
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
  /**
   * Injection point (Approach A) for the POST HTTP call used by setReaction.
   * Defaults to calling im.v1.messageReaction.create on the lark Client.
   * Tests inject a vi.fn() to avoid real network calls.
   */
  httpPost?: (path: string, body: unknown) => Promise<unknown>;
  /**
   * Injection point (Approach A) for the DELETE HTTP call used by setReaction.
   * Defaults to calling im.v1.messageReaction.delete on the lark Client.
   * Tests inject a vi.fn() to avoid real network calls.
   */
  httpDelete?: (path: string) => Promise<unknown>;
}

export class FeishuAdapter implements PlatformAdapter {
  readonly channelType: ChannelType = 'feishu';
  private readonly client: unknown;
  private readonly wsClient: { start(p: { eventDispatcher: unknown }): Promise<void>; close(p?: { force?: boolean }): void } | null;
  private readonly eventDispatcher: unknown | null;
  private readonly options: FeishuAdapterOptions;
  private readonly inboundListeners = new Set<(ev: InboundEvent) => void>();
  /** messageId → reaction_id cache for setReaction (size cap 512). */
  private readonly reactionCache = new Map<string, string>();
  private readonly httpPost: (path: string, body: unknown) => Promise<unknown>;
  private readonly httpDelete: (path: string) => Promise<unknown>;

  constructor(options: FeishuAdapterOptions) {
    this.options = options;

    // ---- Client (outbound REST) ----
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const domain = options.lark ? Domain.Lark : Domain.Feishu;
      this.client = new LarkClient({ appId: options.appId, appSecret: options.appSecret, domain });
    }

    // ---- HTTP injection for setReaction (Approach A) ----
    // If the caller provides httpPost/httpDelete (test path), use them directly.
    // Otherwise, build thin wrappers around the lark SDK client's reaction API.
    if (options.httpPost) {
      this.httpPost = options.httpPost;
    } else {
      this.httpPost = (path: string, body: unknown) => {
        // Production path: parse the messageId from the URL and call the SDK.
        // URL form: /open-apis/im/v1/messages/{messageId}/reactions
        const match = /\/messages\/([^/]+)\/reactions$/.exec(path);
        if (!match) return Promise.reject(new Error(`httpPost: unrecognised path: ${path}`));
        const messageId = match[1]!;
        const c = this.client as {
          im: { v1: { messageReaction: { create: (args: unknown) => Promise<unknown> } } };
        };
        return c.im.v1.messageReaction.create({ path: { message_id: messageId }, data: body });
      };
    }
    if (options.httpDelete) {
      this.httpDelete = options.httpDelete;
    } else {
      this.httpDelete = (path: string) => {
        // Production path: parse messageId + reactionId from the URL and call the SDK.
        // URL form: /open-apis/im/v1/messages/{messageId}/reactions/{reactionId}
        const match = /\/messages\/([^/]+)\/reactions\/([^/]+)$/.exec(path);
        if (!match) return Promise.reject(new Error(`httpDelete: unrecognised path: ${path}`));
        const [, messageId, reactionId] = match;
        const c = this.client as {
          im: { v1: { messageReaction: { delete: (args: unknown) => Promise<unknown> } } };
        };
        return c.im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } });
      };
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
      return this.guard429('send.attachment', () =>
        sendFeishuAttachment({ client: this.mustClient(), chatId: msg.chatId, attachment: { ...msg.attachment!, caption: msg.text } }),
      );
    }
    const card = buildInlineCard(msg.text ?? '', msg.replyMarkup);
    const content = JSON.stringify(card);
    const c = this.mustClient() as {
      im: { v1: { message: { create: (args: unknown) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }> } } };
    };
    const res = await this.guard429('send', () => c.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: msg.chatId,
        msg_type: 'interactive',
        content,
      },
    }));
    this.checkLarkCode(res, 'send');
    return res.data?.message_id ?? '';
  }

  async edit(messageId: string, _chatId: string, text?: string, markup?: ReplyMarkup): Promise<void> {
    const card = buildInlineCard(text ?? '', markup);
    const c = this.mustClient() as {
      im: { v1: { message: { patch: (args: unknown) => Promise<{ code?: number; msg?: string }> } } };
    };
    const res = await this.guard429('edit', () => c.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }));
    this.checkLarkCode(res, 'edit');
  }

  async delete(messageId: string, _chatId: string): Promise<void> {
    const c = this.mustClient() as {
      im: { v1: { message: { delete: (args: unknown) => Promise<{ code?: number; msg?: string }> } } };
    };
    const res = await this.guard429('delete', () => c.im.v1.message.delete({ path: { message_id: messageId } }));
    this.checkLarkCode(res, 'delete');
  }

  async pin(messageId: string, _chatId: string): Promise<void> {
    const c = this.mustClient() as {
      im: { v1: { pin: { create: (args: unknown) => Promise<{ code?: number; msg?: string }> } } };
    };
    const res = await this.guard429('pin', () => c.im.v1.pin.create({ data: { message_id: messageId } }));
    this.checkLarkCode(res, 'pin');
  }

  async setReaction(messageId: string, _chatId: string, emoji: string | null): Promise<void> {
    if (emoji === null) {
      const cached = this.reactionCache.get(messageId);
      if (!cached) return;
      try {
        await this.httpDelete(`/open-apis/im/v1/messages/${messageId}/reactions/${cached}`);
        this.reactionCache.delete(messageId);
      } catch (err) {
        this.options.logger?.warn('feishu setReaction(null) failed', {
          messageId, reactionId: cached,
          reason: (err as Error).message,
          errCode: (err as { code?: number }).code,
          errResponse: (err as { response?: { data?: unknown } }).response?.data,
        });
      }
      return;
    }

    const emojiType = feishuEmojiType(emoji);
    if (!emojiType) {
      this.options.logger?.warn('feishu setReaction: unmapped reaction emoji', { messageId, emoji });
      return;
    }

    const cached = this.reactionCache.get(messageId);
    if (cached) {
      try {
        await this.httpDelete(`/open-apis/im/v1/messages/${messageId}/reactions/${cached}`);
      } catch (err) {
        this.options.logger?.warn('feishu setReaction: prior delete failed (continuing)', {
          messageId, cached,
          reason: (err as Error).message,
          errCode: (err as { code?: number }).code,
          errResponse: (err as { response?: { data?: unknown } }).response?.data,
        });
      }
      this.reactionCache.delete(messageId);
    }

    try {
      const resp = await this.httpPost(
        `/open-apis/im/v1/messages/${messageId}/reactions`,
        { reaction_type: { emoji_type: emojiType } },
      );
      const newId = (resp as { data?: { reaction_id?: string } })?.data?.reaction_id;
      if (newId) {
        // size cap 512: evict oldest-inserted entry when full
        if (this.reactionCache.size >= 512) {
          const oldestKey = this.reactionCache.keys().next().value;
          if (oldestKey !== undefined) this.reactionCache.delete(oldestKey);
        }
        this.reactionCache.set(messageId, newId);
      }
    } catch (err) {
      this.options.logger?.warn('feishu setReaction failed', {
        messageId, emoji, emojiType,
        reason: (err as Error).message,
        errCode: (err as { code?: number }).code,
        errResponse: (err as { response?: { data?: unknown } }).response?.data,
      });
    }
  }

  async sendCard(opts: { chatId: string; threadId?: string; card: object }): Promise<string> {
    const c = this.mustClient() as {
      im: { v1: { message: { create: (args: unknown) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }> } } };
    };
    const res = await this.guard429('sendCard', () => c.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: opts.chatId,
        msg_type: 'interactive',
        content: JSON.stringify(opts.card),
      },
    }));
    this.checkLarkCode(res, 'sendCard');
    return res.data?.message_id ?? '';
  }

  async updateCard(messageId: string, _chatId: string, card: object): Promise<void> {
    const c = this.mustClient() as {
      im: { v1: { message: { patch: (args: unknown) => Promise<{ code?: number; msg?: string }> } } };
    };
    const res = await this.guard429('updateCard', () => c.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }));
    this.checkLarkCode(res, 'updateCard');
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
      im: { v1: { message: { create: (args: unknown) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }> } } };
    };
    const res = await this.guard429('sendFormCard', () => c.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content,
      },
    }));
    this.checkLarkCode(res, 'sendFormCard');
    return res.data?.message_id ?? '';
  }

  async sendAttachment(
    chatId: string,
    attachment: OutboundAttachment | undefined,
    _replyMarkup?: ReplyMarkup,
    _threadId?: string,
  ): Promise<string> {
    if (!attachment) throw new Error('FeishuAdapter.sendAttachment: attachment required');
    return this.guard429('sendAttachment', () =>
      sendFeishuAttachment({ client: this.mustClient(), chatId, attachment }),
    );
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
    // Feishu card 2.0 'card.action.trigger' event has open_chat_id /
    // open_message_id under `event.context.*`, not at top level. Lark
    // EventDispatcher flattens header+event to top-level (so `action`,
    // `operator`, `context` are reachable directly), but `context`
    // itself stays nested. We accept BOTH shapes (top-level fallback)
    // so the legacy test fixture and real production payload both work.
    const p = payload as {
      action?: { value?: { callback_data?: string } };
      form_value?: Record<string, string>;
      operator?: { open_id?: string; user_id?: string };
      // card 2.0 (production) — fields live here:
      context?: { open_chat_id?: string; open_message_id?: string };
      // legacy / fixture fallback:
      open_message_id?: string;
      open_chat_id?: string;
    };
    const userId = p.operator?.open_id ?? p.operator?.user_id ?? '';
    const chatId = p.context?.open_chat_id ?? p.open_chat_id ?? '';
    const messageId = p.context?.open_message_id ?? p.open_message_id ?? '';
    const callbackData = p.action?.value?.callback_data;
    const formValues = p.form_value;
    if (formValues && Object.keys(formValues).length > 0) {
      return {
        channelType: 'feishu',
        chatId,
        messageId,
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
      chatId,
      messageId,
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

  /**
   * Wrap a lark Client API call so transport-level rate-limit signals
   * (HTTP 429 surfaced as AxiosError with response.status===429) become
   * `RateLimitError`. Lark also returns a 429-equivalent in the JSON body
   * (`code: 99991663`) — that's caught by `checkLarkCode` after the call
   * resolves; both paths funnel into the same RateLimitError type.
   */
  private async guard429<T>(action: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { msg?: string; code?: number } }; message?: string };
      const status = e?.response?.status;
      if (status === 429) {
        const body = e?.response?.data;
        const desc = body?.msg ?? e?.message ?? `${action} 429`;
        throw new RateLimitError(1000, 'feishu', desc);
      }
      throw err;
    }
  }

  /**
   * Lark returns errors in the response body as `{ code, msg, data }` with
   * non-zero `code`. The rate-limit code is `99991663` (open-platform
   * frequency limit). Other non-zero codes pass through as a generic Error
   * — we don't pretend to know their semantics here.
   */
  private checkLarkCode(res: { code?: number; msg?: string }, action: string): void {
    const code = res?.code;
    if (code === undefined || code === 0) return;
    if (code === 99991663) {
      throw new RateLimitError(1000, 'feishu', res?.msg ?? `${action} rate limited`);
    }
    // Other non-zero codes — surface but don't dress up. The existing test
    // mocks resolve with `{ data: { ... } }` (no `code`), so this branch
    // does NOT fire for those. New code paths that explicitly mock `code`
    // will raise here.
    throw new Error(`feishu ${action} failed: code=${code} msg=${res?.msg ?? ''}`);
  }

  private emitInbound(ev: InboundEvent): void {
    for (const l of this.inboundListeners) {
      try { l(ev); } catch { /* isolate */ }
    }
  }
}
