// src/im/render/activity-sticky.ts
//
// Anchor #3 — per-turn activity sticky (spec §7.3). One message per turn,
// edit-in-place, throttled to 1.5 s. Content evolves through phases:
//   🧠 thinking…  →  🔧 {currentTool}  →  ✅ done · 1.2s · $0.01
// Embeds parallel-tool and subagent sub-blocks, optional cache/mode badges,
// queue count footer, and prompt-suggestion inline buttons when present.
//
// Throttling: any non-phase-transition edit is deferred to at most 1.5 s
// after the previous flush; phase transitions (turn_start, turn_end,
// tool_use_start→finished, parallel_tool_batch_end) force an immediate
// flush so perceived responsiveness stays high.
//
// v1.0 — renderer-per-target. Each ActivityStickyRenderer instance serves
// exactly one RenderTarget. SessionFrontend constructs one per binding.

import type { NotificationEvent } from '../../runtime/events.js';
import type { RendererDeps, SessionRenderState, TurnRenderState, RenderTarget } from './types.js';
import { targetKey } from './types.js';
import { renderParallelBlock } from './parallel-tools.js';
import { renderSubagentBlock } from './subagent-nested.js';
import { formatCacheBadge } from './cache-badge.js';
import type { InlineButton, ReplyMarkup } from '../../platform/types.js';

export const ACTIVITY_EDIT_THROTTLE_MS = 1500;

export interface ActivityStickyRendererOptions extends RendererDeps {
  session: SessionRenderState;
  /** Override Date.now() in tests. */
  clock?: () => number;
  /** Override setTimeout/clearTimeout in tests (fake timers accepted). */
  timers?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
}

export class ActivityStickyRenderer {
  private readonly adapter: ActivityStickyRendererOptions['adapter'];
  private readonly capabilities: ActivityStickyRendererOptions['capabilities'];
  private readonly session: SessionRenderState;
  private readonly target: RenderTarget;
  private readonly clock: () => number;
  private readonly timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  /** Per-target flush timer. Stored here (not on TurnRenderState) because
   *  there is one ActivityStickyRenderer per target. */
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Per-target "last text rendered" so identical re-renders are skipped. */
  private lastText: string | undefined;
  /** Per-target last edit time for throttle bookkeeping. */
  private lastEditMs = 0;
  /**
   * Latest runtime_error captured during this turn — surfaced as an explicit
   * banner line in the sticky so users see WHY a turn died, not just that
   * it ended. Reset implicitly when a new turn starts (a new TurnRenderState
   * triggers a re-instantiation of buildText with no error context yet).
   */
  private lastError: { severity: 'warn' | 'fatal'; code: string; message: string } | undefined;
  /** Turn id this lastError belongs to — clears on new turn. */
  private lastErrorTurnId: string | undefined;

  constructor(opts: ActivityStickyRendererOptions) {
    this.adapter = opts.adapter;
    this.capabilities = opts.capabilities;
    this.session = opts.session;
    this.target = opts.target;
    this.clock = opts.clock ?? (() => Date.now());
    this.timers = opts.timers ?? { setTimeout, clearTimeout };
  }

  /** Called by frontend on every event the turn cares about. */
  async onEvent(event: NotificationEvent): Promise<void> {
    const turn = this.session.turn;
    if (!turn) return;
    // turn_end → delete the activity sticky instead of rendering one more
    // "🧠 thinking …" frame. The header card already carries cost + status,
    // and `session_complete` is not fired in streaming-input mode (the SDK
    // iter stays open across turns), so teardown() called on session detach
    // would not reach here in time. Cleanly removing the sticky on turn_end
    // matches user expectation that "thinking" disappears when the turn
    // resolves.
    if (event.kind === 'turn_end') {
      if (this.flushTimer) {
        this.timers.clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      // If a fatal runtime_error happened during this turn, leave the sticky
      // up so the user sees what went wrong. The next turn_start will wipe
      // it via the normal new-turn path. Warn-level errors still allow the
      // delete because the agent recovered and produced an answer.
      const fatal = this.lastError?.severity === 'fatal' && this.lastErrorTurnId === turn.turnId;
      if (fatal) {
        await this.render(true);
        return;
      }
      const msgId = this.activityMsgIdFor(turn, this.target);
      if (msgId) {
        try { await this.adapter.delete(msgId, this.target.chatId); } catch { /* isolate */ }
        if (this.target.role === 'primary') {
          turn.activityMsgId = undefined;
        } else {
          (turn as TurnWithMirrors)._mirrorActivityMsgIds?.delete(targetKey(this.target));
        }
      }
      return;
    }
    let force = false;
    switch (event.kind) {
      case 'turn_start':
        // New turn → wipe stale error context from the previous turn so
        // the sticky doesn't carry it forward.
        this.lastError = undefined;
        this.lastErrorTurnId = undefined;
        force = true;
        break;
      case 'parallel_tool_batch_start':
      case 'parallel_tool_batch_end':
      case 'subagent_start':
      case 'subagent_stop':
      case 'tool_use_start':
      case 'tool_use_result':
      case 'prompt_suggestion':
        force = true;
        break;
      case 'runtime_error':
        this.lastError = {
          severity: event.severity,
          code: event.code,
          message: event.message,
        };
        this.lastErrorTurnId = turn.turnId;
        force = true;
        break;
      default:
        force = false;
    }
    await this.render(force);
  }

  /** Flush any pending deferred edit immediately. */
  async flush(): Promise<void> {
    const turn = this.session.turn;
    if (!turn) return;
    if (this.flushTimer) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.render(true);
  }

  /** Remove the activity sticky (called on turn teardown / session stop). */
  async teardown(): Promise<void> {
    if (this.flushTimer) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  // ---- Internal -----------------------------------------------------------

  private async render(force: boolean): Promise<void> {
    const turn = this.session.turn;
    if (!turn) return;
    const now = this.clock();
    const sinceLast = now - this.lastEditMs;

    if (!force && sinceLast < ACTIVITY_EDIT_THROTTLE_MS) {
      // Defer. Schedule (or keep) a flush timer to enforce eventual render.
      if (!this.flushTimer) {
        const delay = ACTIVITY_EDIT_THROTTLE_MS - sinceLast;
        this.flushTimer = this.timers.setTimeout(() => {
          this.flushTimer = undefined;
          void this.render(true).catch(() => { /* isolate */ });
        }, delay);
      }
      return;
    }

    if (this.flushTimer) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    const text = this.buildText(turn);
    if (text === this.lastText) return;
    const markup = this.buildMarkup(turn);

    await this.renderForTarget(turn, text, markup);
    this.lastText = text;
    this.lastEditMs = now;
  }

  private async renderForTarget(
    turn: TurnRenderState,
    text: string,
    markup: ReplyMarkup | undefined,
  ): Promise<void> {
    const target = this.target;
    const msgId = this.activityMsgIdFor(turn, target);
    const effectiveMarkup = target.role === 'primary' ? markup : undefined;
    if (msgId && this.capabilities.editMessage) {
      try {
        await this.adapter.edit(msgId, target.chatId, text, effectiveMarkup);
        return;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[activity-render] edit failed channel=${target.channelType} chat=${target.chatId} reason=${reason}; falling back to send + delete old\n`,
        );
        // Best-effort delete the stale sticky so only one copy shows in chat.
        try { await this.adapter.delete(msgId, target.chatId); } catch { /* ignore */ }
      }
    }
    const sent = await this.adapter.send({
      chatId: target.chatId,
      threadId: target.threadId,
      text,
      replyMarkup: effectiveMarkup,
      silent: true,
    });
    this.storeActivityMsgId(turn, target, sent);
  }

  private buildText(turn: TurnRenderState): string {
    const elapsed = Math.max(0, this.clock() - turn.startedAtMs);
    const elapsedStr = `${(elapsed / 1000).toFixed(1)}s`;
    const parts: string[] = [];

    // Phase line
    if (turn.currentTool) {
      parts.push(`🔧 ${turn.currentTool} · ${elapsedStr}`);
    } else if (turn.parallelTools.size > 0) {
      parts.push(`🔧 running · ${elapsedStr}`);
    } else {
      parts.push(`🧠 thinking · ${elapsedStr}`);
    }

    // Error banner — surface before parallel/subagent blocks so it's the
    // first thing a user sees when a turn faulted. Only show when the error
    // belongs to the CURRENT turn (we wipe lastError on turn_start).
    if (this.lastError && this.lastErrorTurnId === turn.turnId) {
      const sev = this.lastError.severity === 'fatal' ? '🚨' : '⚠️';
      const codePart = this.lastError.code ? ` (${this.lastError.code})` : '';
      // Trim long messages to keep the sticky readable.
      const msg = this.lastError.message.length > 200
        ? this.lastError.message.slice(0, 197) + '…'
        : this.lastError.message;
      parts.push(`${sev} ${msg}${codePart}`);
    }

    const parallel = renderParallelBlock([...turn.parallelTools.values()]);
    if (parallel) parts.push(parallel);

    const subagents = renderSubagentBlock([...turn.subagents.values()]);
    if (subagents) parts.push(subagents);

    // Badges footer
    const footerBits: string[] = [];
    const cache = formatCacheBadge({ warmUntilMs: this.session.cacheWarmUntilMs, nowMs: this.clock() });
    if (cache) footerBits.push(cache);
    if (this.session.modeLabel) footerBits.push(this.session.modeLabel);
    if (turn.queueCount > 0) footerBits.push(`⏭ queue ${turn.queueCount}`);
    if (footerBits.length > 0) parts.push(footerBits.join(' · '));

    return parts.join('\n');
  }

  private buildMarkup(turn: TurnRenderState): ReplyMarkup | undefined {
    if (!turn.promptSuggestions || turn.promptSuggestions.length === 0) return undefined;
    const row: InlineButton[] = turn.promptSuggestions.slice(0, 3).map((s) => ({
      text: s.text,
      callbackData: `suggest:${s.id}`,
      style: 'default',
    }));
    return { type: 'inline_keyboard', buttons: [row] };
  }

  private activityMsgIdFor(turn: TurnRenderState, target: RenderTarget): string | undefined {
    if (target.role === 'primary') return turn.activityMsgId;
    return (turn as TurnWithMirrors)._mirrorActivityMsgIds?.get(targetKey(target));
  }

  private storeActivityMsgId(turn: TurnRenderState, target: RenderTarget, id: string): void {
    if (target.role === 'primary') {
      turn.activityMsgId = id;
      return;
    }
    const t = turn as TurnWithMirrors;
    if (!t._mirrorActivityMsgIds) t._mirrorActivityMsgIds = new Map();
    t._mirrorActivityMsgIds.set(targetKey(target), id);
  }
}

interface TurnWithMirrors extends TurnRenderState {
  _mirrorActivityMsgIds?: Map<string, string>;
}
