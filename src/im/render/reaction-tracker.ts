// src/im/render/reaction-tracker.ts
//
// Anchor #1 — inbound-message reaction ack (spec §7.3). When the user sends
// a message, the reaction tracker puts 👀 (received) on the inbound message.
// On turn_start it upgrades to 🤔 (processing), on turn_end to 🎉, and on
// failure to 💔.
//
// Emoji choice: Telegram's `setMessageReaction` only accepts a fixed Bot API
// whitelist (~84 emoji). 👁️/⏳/✅/❌ are NOT in it — they trigger
// REACTION_INVALID. The current set is in the whitelist on Telegram and
// renders fine on Feishu's fallback reply path. 🎉 / 💔 chosen specifically
// for visual + color distinction (success vs failure should not look like
// 👍/👎 which a glance can confuse).
//
// Feishu fallback (capabilities.reactions === false): send a short reply
// message containing the emoji and track that id so we can delete/edit it on
// subsequent state changes, keeping the channel clean.

import type { RendererDeps, SessionRenderState, RenderTarget } from './types.js';

export type ReactionPhase = 'received' | 'processing' | 'done_ok' | 'done_err';

const EMOJI_FOR: Record<ReactionPhase, string> = {
  received: '👀',
  processing: '🤔',
  done_ok: '🎉',
  done_err: '💔',
};

export interface ReactionTrackerOptions extends RendererDeps {
  session: SessionRenderState;
}

/**
 * Per-session reaction coordinator. Tracks the most recent inbound message
 * id so we can update its reaction across the turn phases.
 */
export class ReactionTracker {
  private readonly adapter: ReactionTrackerOptions['adapter'];
  private readonly capabilities: ReactionTrackerOptions['capabilities'];
  private readonly session: SessionRenderState;
  private readonly target: RenderTarget;
  /** Fallback reply-message ids keyed by inbound messageId. */
  private readonly fallbackMsgIds = new Map<string, string>();

  constructor(opts: ReactionTrackerOptions) {
    this.adapter = opts.adapter;
    this.capabilities = opts.capabilities;
    this.session = opts.session;
    this.target = opts.target;
    void this.target;
  }

  async setPhase(
    inbound: { chatId: string; messageId: string; threadId?: string },
    phase: ReactionPhase,
  ): Promise<void> {
    const emoji = EMOJI_FOR[phase];
    if (this.capabilities.reactions) {
      // Native: adapter replaces whatever emoji was there.
      await this.adapter.setReaction(inbound.messageId, inbound.chatId, emoji);
      this.session.lastInboundReactionMsg = { ...inbound, emoji };
      return;
    }
    // Fallback: send (or edit) a reply-message with the emoji.
    const existing = this.fallbackMsgIds.get(inbound.messageId);
    if (existing) {
      if (this.capabilities.editMessage) {
        await this.adapter.edit(existing, inbound.chatId, emoji);
        return;
      }
      // Can't edit → delete + re-send to keep single reply fresh.
      try { await this.adapter.delete(existing, inbound.chatId); } catch { /* isolate */ }
      this.fallbackMsgIds.delete(inbound.messageId);
    }
    const sent = await this.adapter.send({
      chatId: inbound.chatId,
      threadId: inbound.threadId,
      text: emoji,
      replyToMessageId: inbound.messageId,
      silent: true,
    });
    this.fallbackMsgIds.set(inbound.messageId, sent);
  }

  async clear(inbound: { chatId: string; messageId: string }): Promise<void> {
    if (this.capabilities.reactions) {
      await this.adapter.setReaction(inbound.messageId, inbound.chatId, null);
      return;
    }
    const existing = this.fallbackMsgIds.get(inbound.messageId);
    if (!existing) return;
    try { await this.adapter.delete(existing, inbound.chatId); } catch { /* isolate */ }
    this.fallbackMsgIds.delete(inbound.messageId);
  }
}
