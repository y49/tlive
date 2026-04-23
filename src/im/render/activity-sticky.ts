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
  private readonly clock: () => number;
  private readonly timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

  constructor(opts: ActivityStickyRendererOptions) {
    this.adapter = opts.adapter;
    this.capabilities = opts.capabilities;
    this.session = opts.session;
    this.clock = opts.clock ?? (() => Date.now());
    this.timers = opts.timers ?? { setTimeout, clearTimeout };
  }

  /** Called by frontend on every event the turn cares about. */
  async onEvent(event: NotificationEvent): Promise<void> {
    const turn = this.session.turn;
    if (!turn) return;
    let force = false;
    switch (event.kind) {
      case 'turn_start':
      case 'turn_end':
      case 'parallel_tool_batch_start':
      case 'parallel_tool_batch_end':
      case 'subagent_start':
      case 'subagent_stop':
      case 'tool_use_start':
      case 'tool_use_result':
      case 'runtime_error':
      case 'prompt_suggestion':
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
    if (turn.activityFlushTimer) {
      this.timers.clearTimeout(turn.activityFlushTimer);
      turn.activityFlushTimer = undefined;
    }
    await this.render(true);
  }

  /** Remove the activity sticky (called on turn teardown / session stop). */
  async teardown(): Promise<void> {
    const turn = this.session.turn;
    if (!turn) return;
    if (turn.activityFlushTimer) {
      this.timers.clearTimeout(turn.activityFlushTimer);
      turn.activityFlushTimer = undefined;
    }
  }

  // ---- Internal -----------------------------------------------------------

  private async render(force: boolean): Promise<void> {
    const turn = this.session.turn;
    if (!turn) return;
    const now = this.clock();
    const sinceLast = now - turn.activityLastEditMs;

    if (!force && sinceLast < ACTIVITY_EDIT_THROTTLE_MS) {
      // Defer. Schedule (or keep) a flush timer to enforce eventual render.
      if (!turn.activityFlushTimer) {
        const delay = ACTIVITY_EDIT_THROTTLE_MS - sinceLast;
        turn.activityFlushTimer = this.timers.setTimeout(() => {
          turn.activityFlushTimer = undefined;
          void this.render(true).catch(() => { /* isolate */ });
        }, delay);
      }
      return;
    }

    if (turn.activityFlushTimer) {
      this.timers.clearTimeout(turn.activityFlushTimer);
      turn.activityFlushTimer = undefined;
    }

    const text = this.buildText(turn);
    if (text === turn.activityLastText) return;
    const markup = this.buildMarkup(turn);

    // First render: create per-primary-target only (mirrors get a copy but
    // without interactive buttons).
    for (const target of this.session.targets) {
      await this.renderForTarget(target, turn, text, markup);
    }
    turn.activityLastText = text;
    turn.activityLastEditMs = now;
  }

  private async renderForTarget(
    target: RenderTarget,
    turn: TurnRenderState,
    text: string,
    markup: ReplyMarkup | undefined,
  ): Promise<void> {
    const msgId = this.activityMsgIdFor(turn, target);
    const effectiveMarkup = target.role === 'primary' ? markup : undefined;
    if (msgId && this.capabilities.editMessage) {
      try {
        await this.adapter.edit(msgId, target.chatId, text, effectiveMarkup);
        return;
      } catch { /* fall through to re-send */ }
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
