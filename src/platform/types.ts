// src/platform/types.ts
//
// PlatformAdapter — the platform-agnostic transport contract. Every concrete
// adapter (Telegram/Discord/Feishu) implements this interface; the
// SessionFrontend + renderers target it only, never the underlying SDK.
//
// Design rationale:
// - `send` returns the platform-assigned message id so renderers can later
//   edit/delete/pin it. For adapters whose API does not surface ids
//   synchronously, the adapter synthesizes a stable id and retains the
//   mapping internally.
// - `setReaction(emoji = null)` clears the reaction. Matrix callers check
//   capabilities.reactions before calling; Feishu's adapter throws if
//   invoked directly since the renderer is expected to fall back first.
// - `onInbound` is wired by T7's CommandRouter; T6 tests assert that
//   subscribe/unsubscribe does not leak listeners.
//
// Spec: docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md §10.

import type { ChannelType } from '../workspace/bindings.js';

export type ParseMode = 'markdown' | 'html' | 'plain';

export interface ReplyMarkup {
  type: 'inline_keyboard' | 'force_reply' | 'modal' | 'form_card';
  /** Row-major inline keyboard grid. */
  buttons?: Array<Array<InlineButton>>;
  /** Form fields when `type: 'modal' | 'form_card'`. */
  formFields?: Array<FormField>;
  /** Placeholder text for force-reply / first modal field. */
  placeholder?: string;
  /** Optional modal/form title. */
  title?: string;
}

export interface InlineButton {
  text: string;
  /** Callback data for click handling. Mutually exclusive with `url`. */
  callbackData?: string;
  /** URL button — opens link directly. */
  url?: string;
  /** Visual hint. Platforms map to their nearest equivalent. */
  style?: 'primary' | 'danger' | 'default';
}

export interface FormField {
  name: string;
  label: string;
  /** Platform-agnostic type; adapters map to platform primitives. */
  type: 'text' | 'textarea' | 'select' | 'url' | 'email';
  required?: boolean;
  placeholder?: string;
  /** For `type: 'select'`. */
  options?: Array<{ value: string; label: string }>;
  /** Default prefill value. */
  default?: string;
}

export interface OutboundAttachment {
  name: string;
  mime: string;
  /** Absolute on-disk path. */
  path: string;
  /** Optional caption; may be trimmed by adapter to capability.maxCaptionLen. */
  caption?: string;
}

export interface OutboundMessage {
  chatId: string;
  /** Thread / topic id (Telegram forum topic, Discord thread, Feishu topic). */
  threadId?: string;
  text?: string;
  parseMode?: ParseMode;
  replyMarkup?: ReplyMarkup;
  attachment?: OutboundAttachment;
  /** When set, platform renders as a reply to this inbound message. */
  replyToMessageId?: string;
  /** Silent send — no push notification. Platforms ignore when unsupported. */
  silent?: boolean;
}

export interface InboundAttachment {
  name: string;
  mime: string;
  /** Platform-specific file reference; pass to downloadAttachment to fetch. */
  fileRef: string;
  sizeBytes: number;
}

export type InboundEventKind = 'message' | 'callback' | 'attachment' | 'form_submit';

export interface InboundEvent {
  channelType: ChannelType;
  chatId: string;
  threadId?: string;
  messageId: string;
  userId: string;
  username?: string;
  /** Message text (or callback button label when available). */
  text?: string;
  attachments?: InboundAttachment[];
  /** Payload for inline-keyboard button clicks. */
  callbackData?: string;
  /** Form submission payload (modal / form_card). */
  formValues?: Record<string, string>;
  kind: InboundEventKind;
  /** Original inbound message id this event replies to, if any. */
  replyToMessageId?: string;
  /** Unix-ms receive timestamp (adapter clock). */
  at: number;
}

export interface PlatformAdapter {
  readonly channelType: ChannelType;
  /** Start the transport (connect, register webhook, setMyCommands, …). */
  start(): Promise<void>;
  /** Graceful shutdown. Idempotent. */
  stop(): Promise<void>;
  /** Send a new message; resolves to the platform-assigned message id. */
  send(msg: OutboundMessage): Promise<string>;
  /** Edit text and/or markup of an already-sent message. */
  edit(
    messageId: string,
    chatId: string,
    text?: string,
    markup?: ReplyMarkup,
    parseMode?: ParseMode,
  ): Promise<void>;
  /** Delete the identified message. */
  delete(messageId: string, chatId: string): Promise<void>;
  /** Pin the identified message (no-op on platforms that don't support). */
  pin(messageId: string, chatId: string): Promise<void>;
  /** Set reaction emoji on an inbound message. Pass null to clear. */
  setReaction(messageId: string, chatId: string, emoji: string | null): Promise<void>;
  /** Upload and send an attachment; returns the platform-assigned message id. */
  sendAttachment(
    chatId: string,
    attachment: OutboundAttachment,
    replyMarkup?: ReplyMarkup,
    threadId?: string,
  ): Promise<string>;
  /** Resolve an inbound attachment fileRef to a Buffer. */
  downloadAttachment(fileRef: string): Promise<Buffer>;
  /** Subscribe to inbound events. Returns unsubscribe fn. */
  onInbound(cb: (ev: InboundEvent) => void): () => void;
}

/**
 * Utility: truncate a text to the platform's maxTextLen. Adds an ellipsis
 * if the text had to be shortened.
 */
export function clampText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(1, maxLen - 1)) + '…';
}

/**
 * Split a long text into chunks no larger than maxLen. Splits on nearest
 * newline when possible to avoid mid-sentence cuts.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
