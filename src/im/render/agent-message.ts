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
import { splitText } from '../../platform/types.js';

export const AGENT_FLUSH_MS = 300;
export const AGENT_FLUSH_CHARS = 200;

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
        await this.flush();
        return;
      }
      default:
        return;
    }
  }

  async flush(): Promise<void> {
    const turn = this.session.turn;
    if (!turn) return;
    if (this.flushTimer) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (turn.agentAccText.length === 0) return;
    if (turn.agentAccText === turn.agentRenderedText) return;

    const chunks = splitText(turn.agentAccText, this.capabilities.maxTextLen);
    await this.renderForTarget(turn, chunks);
    turn.agentRenderedText = turn.agentAccText;
    turn.agentLastFlushMs = this.clock();
    // Component breadcrumb: confirms IM actually saw assistant text. Goes to
    // stderr so daemon.log shows it; doesn't carry sessionId because this
    // renderer doesn't have it threaded in.
    process.stderr.write(
      `[agent-render] flush channel=${this.target.channelType} chat=${this.target.chatId} chunks=${chunks.length} chars=${turn.agentAccText.length}\n`,
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
    // Primary message is index 0; remaining chunks become overflow messages.
    const primaryChunk = chunks[0] ?? '';
    if (turn.agentMsgId && this.capabilities.editMessage) {
      try {
        await this.adapter.edit(turn.agentMsgId, target.chatId, primaryChunk);
      } catch {
        // Fallback: send anew (lose previous id).
        const sent = await this.adapter.send({
          chatId: target.chatId,
          threadId: target.threadId,
          text: primaryChunk,
        });
        if (target.role === 'primary') turn.agentMsgId = sent;
      }
    } else {
      const sent = await this.adapter.send({
        chatId: target.chatId,
        threadId: target.threadId,
        text: primaryChunk,
      });
      if (target.role === 'primary') turn.agentMsgId = sent;
    }

    // Handle overflow continuation messages (each a new send, not edit).
    for (let i = 1; i < chunks.length; i++) {
      const existing = target.role === 'primary' ? turn.agentOverflowMsgIds[i - 1] : undefined;
      if (existing && this.capabilities.editMessage) {
        try {
          await this.adapter.edit(existing, target.chatId, chunks[i]!);
          continue;
        } catch { /* fall through to send */ }
      }
      const sent = await this.adapter.send({
        chatId: target.chatId,
        threadId: target.threadId,
        text: chunks[i]!,
      });
      if (target.role === 'primary') turn.agentOverflowMsgIds[i - 1] = sent;
    }
  }
}
