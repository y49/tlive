// src/im/render/agent-message.ts
//
// Anchor #4 — streaming assistant text (spec §7.3). Accumulates
// assistant_text_delta events, batches into a single message edit at a
// 300 ms / 200-char cadence, and auto-splits into continuation messages
// when the accumulated text exceeds capability.maxTextLen.
//
// Long code blocks (>40 lines) are expected to be attached out-of-band by
// the IM-aware system prompt (Write tool → attachment_produced event);
// AgentMessageRenderer does NOT intercept tool calls, just prints whatever
// text the runtime emits.
//
// v1.0 — renderer-per-target. Each renderer owns its own flush timer on
// its instance (not on TurnRenderState) so multi-binding workspaces don't
// cross-cancel each other's timers.

import type { NotificationEvent } from '../../runtime/events.js';
import type { RendererDeps, SessionRenderState, TurnRenderState, RenderTarget } from './types.js';
import { splitText, type ParseMode } from '../../platform/types.js';

export const AGENT_FLUSH_MS = 300;
export const AGENT_FLUSH_CHARS = 200;

/**
 * Telegram parse modes understood by the agent renderer:
 *   - 'html'    → run our Markdown→HTML converter (preferred for assistant
 *                 text — code fences, **bold**, *italic*, links).
 *   - 'plain'   → no formatting (used by mirror echoes / fallback).
 *
 * The renderer picks 'html' for primary targets when the platform supports
 * editMessage (which is true for all current platforms — they implement HTML
 * via the same `extra.parse_mode` switch on send/edit).
 */
function pickParseMode(target: RenderTarget): ParseMode {
  // Discord/Feishu currently ignore parseMode in their adapters (the values
  //   are passed through but not consumed). For Telegram, 'html' triggers our
  //   formatHtml() converter. Keeping 'html' for non-Telegram targets is
  //   harmless because their adapters drop it.
  if (target.role === 'mirror') return 'plain';
  return 'html';
}

/**
 * Pretty footer appended to the assistant message on `turn_end`. Conditional:
 * if there are no tool uses AND no usage stats AND no cost, returns null and
 * the renderer skips the footer entirely.
 *
 *   📦 Bash ×2 · Read ×1 (3 total)
 *   📊 7/528 tok · $0.09 (Σ $0.12) · 32s
 */
export function buildAgentFooter(turn: TurnRenderState, sessionCostUsd: number): string | null {
  const stats = turn.lastTurnStats;
  if (!stats && turn.toolUseCounts.size === 0) return null;
  const lines: string[] = [];
  if (turn.toolUseCounts.size > 0) {
    const total = [...turn.toolUseCounts.values()].reduce((s, n) => s + n, 0);
    const parts = [...turn.toolUseCounts.entries()].map(([name, n]) => `${name} ×${n}`);
    lines.push(`📦 ${parts.join(' · ')} (${total} total)`);
  }
  if (stats) {
    const tok = `${stats.tokensIn}/${stats.tokensOut} tok`;
    const cost = `$${stats.costUsd.toFixed(2)}`;
    const sess = `Σ $${sessionCostUsd.toFixed(2)}`;
    const dur = `${(Math.max(0, stats.durationMs) / 1000).toFixed(1)}s`;
    lines.push(`📊 ${tok} · ${cost} (${sess}) · ${dur}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

export interface AgentMessageRendererOptions extends RendererDeps {
  session: SessionRenderState;
  clock?: () => number;
  timers?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
}

export class AgentMessageRenderer {
  private readonly adapter: AgentMessageRendererOptions['adapter'];
  private readonly capabilities: AgentMessageRendererOptions['capabilities'];
  private readonly session: SessionRenderState;
  private readonly target: RenderTarget;
  private readonly clock: () => number;
  private readonly timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  /** Per-target flush timer (avoids cross-target cancellation). */
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Promise representing the latest in-flight flush. Concurrent callers chain
   * on this so flushes execute sequentially. Without serialization, two
   * concurrent flushes could both observe `turn.agentMsgId === undefined`
   * (the first hasn't returned yet) and both call adapter.send — producing
   * two distinct primary messages instead of one. Symptom: the same Claude
   * reply text appears twice in IM.
   */
  private inFlightFlush: Promise<void> = Promise.resolve();

  constructor(opts: AgentMessageRendererOptions) {
    this.adapter = opts.adapter;
    this.capabilities = opts.capabilities;
    this.session = opts.session;
    this.target = opts.target;
    this.clock = opts.clock ?? (() => Date.now());
    this.timers = opts.timers ?? { setTimeout, clearTimeout };
  }

  async onEvent(event: NotificationEvent): Promise<void> {
    const turn = this.session.turn;
    if (!turn) return;
    switch (event.kind) {
      case 'assistant_text_delta': {
        turn.agentAccText += event.text;
        turn.hasAssistantText = true;
        const now = this.clock();
        const sinceFlush = now - turn.agentLastFlushMs;
        const pending = turn.agentAccText.length - turn.agentRenderedText.length;
        if (pending >= AGENT_FLUSH_CHARS) {
          await this.flush();
          return;
        }
        if (!this.flushTimer) {
          const delay = Math.max(0, AGENT_FLUSH_MS - sinceFlush);
          this.flushTimer = this.timers.setTimeout(() => {
            this.flushTimer = undefined;
            void this.flush().catch(() => { /* isolate */ });
          }, delay);
        }
        return;
      }
      case 'assistant_text': {
        // Complete message — replace whatever we'd streamed and flush.
        turn.agentAccText = event.text;
        turn.hasAssistantText = true;
        await this.flush();
        return;
      }
      case 'turn_end': {
        // Capture turn stats locally so buildAgentFooter can stamp the
        // tokens/cost/duration line even when this renderer is driven
        // directly (in tests) without the frontend's pre-flush bookkeeping.
        // The frontend ALSO sets turn.lastTurnStats before calling onEvent
        // for the same value, so this is idempotent in production.
        turn.lastTurnStats = {
          durationMs: event.durationMs ?? 0,
          costUsd: event.costUsd ?? 0,
          tokensIn: event.tokensIn ?? 0,
          tokensOut: event.tokensOut ?? 0,
        };
        await this.flush();
        return;
      }
      default:
        return;
    }
  }

  async flush(): Promise<void> {
    // Chain on the previous in-flight flush so two callers can never both
    // see `turn.agentMsgId === undefined` and double-send. The chain swallows
    // prior errors so a failed flush doesn't poison subsequent ones.
    const next = this.inFlightFlush.then(
      () => this.doFlush(),
      () => this.doFlush(),
    );
    this.inFlightFlush = next.then(() => undefined, () => undefined);
    return next;
  }

  private async doFlush(): Promise<void> {
    const turn = this.session.turn;
    if (!turn) return;
    if (this.flushTimer) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (turn.agentAccText.length === 0) return;

    // Compose the rendered body. On turn_end (lastTurnStats set) we append
    // a footer line so the user sees tool count + tokens + cost + duration
    // beneath the answer. The footer is HTML-escaped raw text — no markdown
    // tokens — so formatHtml() will treat it as plain (escapes only).
    // We only stamp a footer when there is actual assistant text; an empty
    // turn (the agent ran tools and said nothing) shouldn't produce a
    // "no-content" message just to display stats.
    const body = turn.agentAccText;
    const footer = buildAgentFooter(turn, this.session.costUsd);
    const composed = footer ? `${body}\n\n${footer}` : body;

    if (composed === turn.agentRenderedText) return;

    // Snapshot the text and mark it as rendered BEFORE awaiting the network
    // call. This makes flush() reentry-safe: if the deferred-flush timer
    // fires while we are awaiting renderForTarget, the timer's flush()
    // observes agentAccText === agentRenderedText and returns immediately
    // instead of double-sending. Without this guard the same text was sent
    // twice (once by the await-completing flush, once by the timer-fired
    // flush), producing duplicate "你好！..." messages in IM.
    turn.agentRenderedText = composed;
    turn.agentLastFlushMs = this.clock();

    const chunks = splitText(composed, this.capabilities.maxTextLen);
    await this.renderForTarget(turn, chunks);
    // Component breadcrumb: confirms IM actually saw assistant text. Goes to
    // stderr so daemon.log shows it; doesn't carry sessionId because this
    // renderer doesn't have it threaded in.
    process.stderr.write(
      `[agent-render] flush channel=${this.target.channelType} chat=${this.target.chatId} chunks=${chunks.length} chars=${composed.length}\n`,
    );
  }

  /** Teardown: clear pending flush timer and drop any pending batch. */
  async teardown(): Promise<void> {
    if (this.flushTimer) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private async renderForTarget(
    turn: TurnRenderState,
    chunks: string[],
  ): Promise<void> {
    const target = this.target;
    const parseMode = pickParseMode(target);
    // Primary message is index 0; remaining chunks become overflow messages.
    const primaryChunk = chunks[0] ?? '';
    if (turn.agentMsgId && this.capabilities.editMessage) {
      try {
        await this.adapter.edit(turn.agentMsgId, target.chatId, primaryChunk, undefined, parseMode);
      } catch {
        // Fallback: send anew (lose previous id).
        const sent = await this.adapter.send({
          chatId: target.chatId,
          threadId: target.threadId,
          text: primaryChunk,
          parseMode,
        });
        if (target.role === 'primary') turn.agentMsgId = sent;
      }
    } else {
      const sent = await this.adapter.send({
        chatId: target.chatId,
        threadId: target.threadId,
        text: primaryChunk,
        parseMode,
      });
      if (target.role === 'primary') turn.agentMsgId = sent;
    }

    // Handle overflow continuation messages (each a new send, not edit).
    for (let i = 1; i < chunks.length; i++) {
      const existing = target.role === 'primary' ? turn.agentOverflowMsgIds[i - 1] : undefined;
      if (existing && this.capabilities.editMessage) {
        try {
          await this.adapter.edit(existing, target.chatId, chunks[i]!, undefined, parseMode);
          continue;
        } catch { /* fall through to send */ }
      }
      const sent = await this.adapter.send({
        chatId: target.chatId,
        threadId: target.threadId,
        text: chunks[i]!,
        parseMode,
      });
      if (target.role === 'primary') turn.agentOverflowMsgIds[i - 1] = sent;
    }
  }
}
