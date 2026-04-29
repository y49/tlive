// src/im/capability-matrix.ts
//
// Per-platform capability matrix (spec §7.2). Every renderer consults this
// before emitting an action that may not be supported by the target
// platform — e.g. reaction emoji on Feishu, native modal on Telegram, or
// pinned messages on a Discord channel without thread context. When a
// capability is absent the matrix tells the renderer to fall back.
//
// The values here are contract: they are asserted verbatim by
// tests/im/capability-matrix.test.ts.
//
// Spec: docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md §7.2.

import type { ChannelType } from '../workspace/bindings.js';

export interface ChannelCapabilities {
  /** Can set native emoji reactions on inbound messages? */
  reactions: boolean;
  /** Can edit a previously-sent bot message? */
  editMessage: boolean;
  /** Can pin a message (per-chat pinned shelf)? */
  pinMessage: boolean;
  /** Can upload files (document / photo) via this platform's API? */
  fileUpload: boolean;
  /** Can prompt the user with a forced-reply input field (Telegram-style)? */
  forceReplyInput: boolean;
  /** Does the platform expose a native modal/form primitive? */
  modalForm: boolean;
  /** Can the platform group messages into per-session threads/topics? */
  threads: boolean;
  /** Does the platform accept a registered command list for autocomplete? */
  autocompleteCommands: boolean;
  /** Maximum characters per text message. */
  maxTextLen: number;
  /** Maximum characters per attachment caption. */
  maxCaptionLen: number;
  /** Can we emit a typing-indicator-style transient hint? */
  sendChatAction: boolean;
  /** Maximum bytes for callback payload (inline button data). */
  callbackDataMaxBytes: number;
  /** Can deliver a structured card payload (e.g. lark card 2.0)? */
  cards: boolean;
}

export const CAPABILITIES: Record<ChannelType, ChannelCapabilities> = {
  telegram: {
    reactions: true,
    editMessage: true,
    pinMessage: true,
    fileUpload: true,
    forceReplyInput: true,
    modalForm: false,              // emulated via forceReply sequence
    threads: true,                  // topics
    autocompleteCommands: true,
    maxTextLen: 4096,
    maxCaptionLen: 1024,
    sendChatAction: true,
    callbackDataMaxBytes: 64,
    cards: false,
  },
  discord: {
    reactions: true,
    editMessage: true,
    pinMessage: false,              // only in thread
    fileUpload: true,
    forceReplyInput: false,
    modalForm: true,                // native modal components
    threads: true,
    autocompleteCommands: true,
    maxTextLen: 2000,
    maxCaptionLen: 2000,
    sendChatAction: true,
    callbackDataMaxBytes: 100,
    cards: false,
  },
  feishu: {
    reactions: false,               // platform has no reaction API
    editMessage: true,
    pinMessage: true,
    fileUpload: true,
    forceReplyInput: false,
    modalForm: true,                // native form card blocks
    threads: true,                  // topics (new feishu)
    autocompleteCommands: false,
    maxTextLen: 10000,              // via card
    maxCaptionLen: 500,
    sendChatAction: false,
    callbackDataMaxBytes: 200,
    cards: true,
  },
};

export function capabilitiesOf(channel: ChannelType): ChannelCapabilities {
  return CAPABILITIES[channel];
}
