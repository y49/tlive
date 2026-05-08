// src/im/reaction-tracker.ts
//
// Anchor #1 — inbound-message reaction ack (spec §7.3). When the user sends
// a message, the reaction tracker puts 👀 (received) on the inbound message.
// On turn_start it upgrades to 🤔 (processing), on turn_end to 👌, and on
// failure to 💔.
//
// Emoji choice: Telegram's `setMessageReaction` only accepts a fixed Bot API
// whitelist (~84 emoji). 👁️/⏳/✅/❌ are NOT in it — they trigger
// REACTION_INVALID. The current set is in the whitelist on Telegram and
// renders natively on Feishu. 👌 / 💔 chosen specifically for visual + color
// distinction (success vs failure should not look like 👍/👎 which a glance
// can confuse). 👌 ("OK hand") communicates a clean completion without 🎉's
// celebratory volume.
//
// Concurrency contract: setPhase calls for the SAME inbound messageId are
// serialized through a per-message queue. SessionFrontend dispatches phases
// in logical order (received → processing → done_ok | done_err), but the
// underlying network calls are async with variable latency — without
// serialization, a slow `processing` setReaction could land AFTER a
// fire-and-forget `done_ok` and revert the user-visible reaction back to 🤔.
// The queue guarantees in-order delivery and the phase-precedence guard
// (`PHASE_RANK`) drops late-arriving lower-rank phases entirely so a stale
// in-flight call never undoes a completed transition.

import type { RendererDeps, SessionRenderState, RenderTarget } from './render/types.js';

export type ReactionPhase = 'received' | 'processing' | 'done_ok' | 'done_err';

const EMOJI_FOR: Record<ReactionPhase, string> = {
  received: '👀',
  processing: '🤔',
  done_ok: '👌',
  done_err: '💔',
};

/** Phase precedence — once a higher rank has been REQUESTED for an inbound,
 *  all lower-rank requests for the same inbound are dropped. Both `done_ok`
 *  and `done_err` are terminal (rank 3); only one wins. */
const PHASE_RANK: Record<ReactionPhase, number> = {
  received: 1,
  processing: 2,
  done_ok: 3,
  done_err: 3,
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
  private readonly session: SessionRenderState;
  private readonly target: RenderTarget;
  /** In-flight write chain per inbound messageId — every setPhase appends to
   *  this so writes happen in caller order regardless of network latency. */
  private readonly chains = new Map<string, Promise<void>>();
  /** Highest-rank phase REQUESTED so far per inbound messageId. Lower-rank
   *  requests submitted after a higher rank are dropped. */
  private readonly highestPhase = new Map<string, ReactionPhase>();

  constructor(opts: ReactionTrackerOptions) {
    this.adapter = opts.adapter;
    this.session = opts.session;
    this.target = opts.target;
    void this.session;
    void this.target;
  }

  async setPhase(
    inbound: { chatId: string; messageId: string; threadId?: string },
    phase: ReactionPhase,
  ): Promise<void> {
    // Phase-precedence: drop late-arriving lower-rank requests so a slow
    // in-flight `processing` can't overwrite a completed `done_ok`.
    const prev = this.highestPhase.get(inbound.messageId);
    if (prev && PHASE_RANK[phase] < PHASE_RANK[prev]) {
      return;
    }
    this.highestPhase.set(inbound.messageId, phase);

    // Chain on the previous in-flight write for THIS messageId so writes
    // are serialized in submission order.
    const prior = this.chains.get(inbound.messageId) ?? Promise.resolve();
    const next = prior.then(
      () => this.applyPhase(inbound, phase),
      () => this.applyPhase(inbound, phase), // even if prior failed, continue
    );
    this.chains.set(inbound.messageId, next);
    try {
      await next;
    } finally {
      // GC chain entry only if it's still the latest (another setPhase may
      // have replaced it while we were awaiting).
      if (this.chains.get(inbound.messageId) === next) {
        this.chains.delete(inbound.messageId);
      }
    }
  }

  private async applyPhase(
    inbound: { chatId: string; messageId: string; threadId?: string },
    phase: ReactionPhase,
  ): Promise<void> {
    // Re-check precedence at apply-time: an even-higher-rank phase may have
    // been queued AFTER us; if so, our write is moot and we drop it to avoid
    // the wasted API call (and the brief flicker it would cause).
    const current = this.highestPhase.get(inbound.messageId);
    if (current && PHASE_RANK[phase] < PHASE_RANK[current]) return;

    const emoji = EMOJI_FOR[phase];
    // Native: adapter replaces whatever emoji was there.
    // If setReaction is unsupported by the adapter it should warn-log + swallow
    // per the adapter contract (Task 4) — the turn render is never blocked.
    await this.adapter.setReaction(inbound.messageId, inbound.chatId, emoji);
  }

  async clear(inbound: { chatId: string; messageId: string }): Promise<void> {
    await this.adapter.setReaction(inbound.messageId, inbound.chatId, null);
  }
}
