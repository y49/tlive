// src/platform/telegram/elicitation.ts
//
// forceReply sequence — Telegram has no native modal primitive, so we emulate
// multi-field forms by asking one question at a time with `force_reply: true`
// and aggregating answers. This module holds only the book-keeping; the
// CommandRouter (T7) wires it to ElicitationBroker.resolve.
//
// One session may have at most one active force-reply sequence per chat.

import type { FormField } from '../types.js';

export interface ForceReplySessionState {
  requestId: string;
  fields: FormField[];
  values: Record<string, string>;
  /** Index of the currently-awaited field. */
  cursor: number;
  /** The message id that asked the current question (for edit-on-complete). */
  promptMsgId?: string;
}

export class ForceReplyTracker {
  /** Keyed by `${chatId}:${userId}` so multiple users in a chat can each have own state. */
  private readonly pending = new Map<string, ForceReplySessionState>();

  begin(chatId: string, userId: string, state: ForceReplySessionState): void {
    this.pending.set(this.key(chatId, userId), state);
  }

  advance(chatId: string, userId: string, answer: string): ForceReplySessionState | null {
    const key = this.key(chatId, userId);
    const s = this.pending.get(key);
    if (!s) return null;
    const field = s.fields[s.cursor];
    if (!field) { this.pending.delete(key); return null; }
    s.values[field.name] = answer;
    s.cursor++;
    if (s.cursor >= s.fields.length) {
      this.pending.delete(key);
      return { ...s, cursor: s.fields.length };
    }
    return s;
  }

  cancel(chatId: string, userId: string): ForceReplySessionState | null {
    const key = this.key(chatId, userId);
    const s = this.pending.get(key);
    if (!s) return null;
    this.pending.delete(key);
    return s;
  }

  peek(chatId: string, userId: string): ForceReplySessionState | undefined {
    return this.pending.get(this.key(chatId, userId));
  }

  private key(chatId: string, userId: string): string {
    return `${chatId}:${userId}`;
  }
}
