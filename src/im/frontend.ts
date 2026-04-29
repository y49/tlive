// src/im/frontend.ts
//
// SessionFrontend — v1.0 IM orchestrator (spec §7.1). Subscribes to the
// three layers that originate UI-bound state (SessionManager, PermissionBroker,
// AskUserQuestionBroker, ElicitationBroker) and dispatches each event to the
// right renderer(s). Maintains a RenderContext per session with per-anchor
// message-id book-keeping, and tears everything down on session stop.
//
// Platform targeting: on each session, we resolve the workspace's bindings
// via WorkspaceManager.partitionBindings, pair each ChannelType with the
// registered PlatformAdapter, and instantiate one renderer-set per binding
// (renderer-per-target — fixes the N×M fan-out bug from T6 review). Mirrors
// render read-only copies; only primaries carry interactive buttons.

import type { SessionManager } from '../session/manager.js';
import type { SessionLike } from '../session/types.js';
import type { NotificationEvent } from '../runtime/events.js';
import type { PermissionBroker, BrokerEvent } from '../permission/broker.js';
import type { AskUserQuestionBroker, AskBrokerEvent } from '../permission/ask-broker.js';
import type { ElicitationBroker, ElicitationBrokerEvent } from '../permission/elicitation-broker.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { ChannelType } from '../workspace/bindings.js';
import type { PlatformAdapter } from '../platform/types.js';
import type { Logger } from '../util/logger.js';
import { capabilitiesOf } from './capability-matrix.js';
import {
  type SessionRenderState,
  newSessionRenderState,
  newTurnRenderState,
  type RenderTarget,
  type TurnRenderState,
  targetKey,
} from './render/types.js';
import { ReactionTracker } from './render/reaction-tracker.js';
import { SessionHeaderRenderer } from './render/session-header.js';
import { ActivityStickyRenderer } from './render/activity-sticky.js';
import { AgentMessageRenderer } from './render/agent-message.js';
import { TodoStickyRenderer } from './render/todo-sticky.js';
import { PermissionCardRenderer } from './render/permission-card.js';
import { ElicitationFormRenderer } from './render/elicitation-form.js';
import { AttachmentPreviewRenderer } from './render/attachment-preview.js';
import { QueueHintRenderer } from './render/queue-hint.js';
import { TurnUI, type HudPanelFactory } from './turn-ui.js';
import { TelegramHudPanel } from './hud/telegram-panel.js';
import { FeishuHudPanel } from './hud/feishu-panel.js';
import { initialHudState, type HudState } from './hud/state.js';
import { targetKey as renderTargetKey } from './render-target.js';
import { ReplyRenderer } from './reply.js';

/**
 * A renderer set lives per (session, binding). All renderers in a set share
 * the same session-level SessionRenderState. The set's adapter is the one
 * for that channel only; every renderer inside operates on `target` alone.
 */
interface ChannelRenderers {
  channelType: ChannelType;
  adapter: PlatformAdapter;
  target: RenderTarget;
  session: SessionRenderState;
  reaction: ReactionTracker;
  header: SessionHeaderRenderer;
  activity: ActivityStickyRenderer;
  agent: AgentMessageRenderer;
  todo: TodoStickyRenderer;
  permission: PermissionCardRenderer;
  elicitation: ElicitationFormRenderer;
  attachment: AttachmentPreviewRenderer;
  queue: QueueHintRenderer;
}

interface SessionEntry {
  sessionId: string;
  workspaceId: string;
  unsubscribeEvent: () => void;
  channels: ChannelRenderers[];
  /** TL_NEW_UX path: per-turn HUD ownership. Replaced on each turn_start. */
  activeTurnUI?: TurnUI;
  /** TL_NEW_UX path: per-turn counter for HUD header display. */
  turnCounter?: number;
  /** TL_NEW_UX path: per-turn reply renderers, keyed by targetKey. Reset on turn_start. */
  replyRenderers?: Map<string, ReplyRenderer>;
  /**
   * TL_NEW_UX path: accumulated assistant text across deltas for the current turn.
   * assistant_text_delta carries only the new portion (diff, partial:true); we
   * accumulate here so ReplyRenderer receives the full text on each call.
   * Reset to '' on turn_start.
   */
  replyAcc?: string;
}

export interface SessionFrontendOptions {
  sessionManager: SessionManager;
  workspaceManager: WorkspaceManager;
  permissionBroker: PermissionBroker;
  askBroker?: AskUserQuestionBroker;
  elicitationBroker?: ElicitationBroker;
  /** Map of registered adapters keyed by channelType. */
  adapters: Partial<Record<ChannelType, PlatformAdapter>>;
  /** Optional structured logger. When provided, the frontend logs entry per
   *  non-noop session event so daemon.log shows the IM-render path. */
  logger?: Logger;
}

/** Helper: stable key for a (channelType, chatId) inbound source. */
function chatKey(channelType: ChannelType, chatId: string): string {
  return `${channelType}:${chatId}`;
}

/**
 * TypeScript exhaustiveness helper. Placing `assertNever(ev)` at the end of
 * a discriminated-union switch forces a compile error if a new kind is
 * added without a corresponding case.
 */
function assertNever(_x: never): void {
  /* nothing at runtime; `_x` should be unreachable */
}

/**
 * Mirrors the noop-case set in handleSessionEvent's switch. Kept as a
 * separate predicate so the dispatch log doesn't fire for every heartbeat
 * tick. Update both this list AND the switch statement when adding new
 * NotificationEvent kinds.
 */
const FRONTEND_NOOP_KINDS = new Set<string>([
  'heartbeat', 'thinking_delta', 'thinking_end', 'subagent_event', 'file_changed',
  'ask_user_question_requested', 'ask_user_question_resolved',
  'elicitation_requested', 'elicitation_resolved',
  'permission_requested', 'permission_resolved',
  'pre_compact', 'post_compact', 'prewarm_tick', 'api_throttle', 'api_resumed',
  'rewind_files', 'session_forked', 'session_renamed', 'mcp_status_change',
  'plugin_reloaded', 'hook_generic', 'status_change',
  'quota_update',
]);

function isFrontendNoopKind(kind: string): boolean {
  return FRONTEND_NOOP_KINDS.has(kind);
}

export class SessionFrontend {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;
  /**
   * Pending inbound messageIds keyed by `chatKey(channelType, chatId)`.
   * Bootstrap calls `markInboundReceived` on every plain-text inbound BEFORE
   * `lazyResumeOrCreate` resolves; in the create branch the SessionFrontend
   * may not yet have a SessionEntry for the new session. We stash here and
   * apply on the next attachSession that owns a matching channel.
   */
  private readonly pendingInbound = new Map<string, { messageId: string; threadId?: string }>();

  constructor(private readonly opts: SessionFrontendOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    // SessionManager lifecycle.
    this.unsubscribers.push(
      this.opts.sessionManager.subscribe((ev) => {
        switch (ev.kind) {
          case 'created':
          case 'resumed':
          case 'registered':
            try { this.attachSession(ev.session); } catch { /* isolate */ }
            break;
          case 'stopped':
            void this.detachSession(ev.sessionId).catch(() => { /* isolate */ });
            break;
        }
      }),
    );

    // PermissionBroker.
    this.unsubscribers.push(
      this.opts.permissionBroker.subscribe((ev) => {
        void this.handlePermissionEvent(ev).catch(() => { /* isolate */ });
      }),
    );

    // AskUserQuestionBroker (render as permission-card-like generic prompt).
    if (this.opts.askBroker) {
      this.unsubscribers.push(
        this.opts.askBroker.subscribe((ev) => {
          void this.handleAskEvent(ev).catch(() => { /* isolate */ });
        }),
      );
    }

    // ElicitationBroker.
    if (this.opts.elicitationBroker) {
      this.unsubscribers.push(
        this.opts.elicitationBroker.subscribe((ev) => {
          void this.handleElicitationEvent(ev).catch(() => { /* isolate */ });
        }),
      );
    }
  }

  async stop(): Promise<void> {
    for (const u of this.unsubscribers) { try { u(); } catch { /* isolate */ } }
    this.unsubscribers.length = 0;
    for (const id of [...this.sessions.keys()]) {
      await this.detachSession(id);
    }
    this.started = false;
  }

  /** Test helper — expose renderer set for a session. */
  getChannelsForTest(sessionId: string): ChannelRenderers[] | undefined {
    return this.sessions.get(sessionId)?.channels;
  }

  // ---- Session attach / detach --------------------------------------------

  private attachSession(session: SessionLike): void {
    if (this.sessions.has(session.id)) return;
    const bindings = this.opts.workspaceManager.partitionBindings(session.workspaceId);
    const workspace = this.opts.workspaceManager.get(session.workspaceId);
    const channels: ChannelRenderers[] = [];
    const targets: RenderTarget[] = bindings.all.map((b) => ({
      channelType: b.channelType,
      chatId: b.chatId,
      threadId: b.threadId,
      role: b.role,
    }));
    const renderState = newSessionRenderState({
      sessionId: session.id,
      shortAlias: session.shortAlias,
      workspaceId: session.workspaceId,
      workspaceName: workspace?.name ?? session.workspaceId,
      targets,
    });
    renderState.model = workspace?.defaults.model;

    for (const target of targets) {
      const adapter = this.opts.adapters[target.channelType];
      if (!adapter) continue;
      const caps = capabilitiesOf(target.channelType);
      const deps = { adapter, capabilities: caps, target };
      const channel: ChannelRenderers = {
        channelType: target.channelType,
        adapter,
        target,
        session: renderState,
        reaction: new ReactionTracker({ ...deps, session: renderState }),
        header: new SessionHeaderRenderer({ ...deps, session: renderState }),
        activity: new ActivityStickyRenderer({ ...deps, session: renderState }),
        agent: new AgentMessageRenderer({ ...deps, session: renderState }),
        todo: new TodoStickyRenderer({ ...deps, session: renderState }),
        permission: new PermissionCardRenderer({ ...deps, session: renderState }),
        elicitation: new ElicitationFormRenderer({ ...deps, session: renderState }),
        attachment: new AttachmentPreviewRenderer({ ...deps, session: renderState }),
        queue: new QueueHintRenderer({ ...deps }),
      };
      channels.push(channel);
    }

    // Initialize session header for every channel (fire-and-forget — visual only,
    // not on the event-flow critical path).
    for (const c of channels) {
      void c.header.initialize().catch(() => { /* isolate */ });
    }

    // Apply any pending inbound that arrived BEFORE this session was attached:
    // bootstrap.handleInbound calls markInboundReceived right before
    // lazyResumeOrCreate, so by the time we see 'created' here the inbound
    // message id is parked in pendingInbound. Drain it into per-channel state
    // and fire the 'received' reaction (👁️) so the user sees an ack.
    for (const c of channels) {
      const key = chatKey(c.target.channelType, c.target.chatId);
      const pending = this.pendingInbound.get(key);
      if (!pending) continue;
      renderState.lastInboundByTarget.set(targetKey(c.target), {
        chatId: c.target.chatId,
        messageId: pending.messageId,
        threadId: pending.threadId,
      });
      this.pendingInbound.delete(key);
      void c.reaction.setPhase(
        { chatId: c.target.chatId, messageId: pending.messageId, threadId: pending.threadId },
        'received',
      ).catch((err) => {
        this.opts.logger?.warn('reaction received failed', {
          sessionId: session.id, channelType: c.target.channelType,
          reason: (err as Error).message,
        });
      });
    }

    const unsubscribeEvent = session.onEvent((ev) => {
      void this.handleSessionEvent(session.id, ev).catch(() => { /* isolate */ });
    });

    this.sessions.set(session.id, {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      unsubscribeEvent,
      channels,
    });
    this.opts.logger?.info('frontend attach', {
      sessionId: session.id, workspaceId: session.workspaceId,
      channels: channels.map((c) => c.target.channelType),
    });
  }

  /**
   * Bootstrap calls this on every plain-text inbound BEFORE driving the
   * workspace's lazyResumeOrCreate. We update both:
   * - `pendingInbound` (drained on next matching attachSession) so freshly
   *   created sessions can fire the 'received' reaction;
   * - any already-attached session whose channel matches (chatKey),
   *   updating `lastInboundByTarget` and immediately firing 'received'.
   *
   * This is the single hook that lets the IM frontend see inbound messages —
   * the rest of the inbound dispatch lives in bootstrap.handleInbound.
   */
  markInboundReceived(channelType: ChannelType, chatId: string, messageId: string, threadId?: string): void {
    const key = chatKey(channelType, chatId);
    this.pendingInbound.set(key, { messageId, threadId });
    // Apply to every already-attached session whose channels include this chat.
    for (const entry of this.sessions.values()) {
      for (const c of entry.channels) {
        if (c.target.channelType !== channelType || c.target.chatId !== chatId) continue;
        c.session.lastInboundByTarget.set(targetKey(c.target), { chatId, messageId, threadId });
        void c.reaction.setPhase({ chatId, messageId, threadId }, 'received').catch((err) => {
          this.opts.logger?.warn('reaction received failed', {
            sessionId: entry.sessionId, channelType,
            reason: (err as Error).message,
          });
        });
        // Drain pending — at least one session consumed it.
        this.pendingInbound.delete(key);
      }
    }
  }

  private async detachSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    try { entry.unsubscribeEvent(); } catch { /* isolate */ }
    try { entry.activeTurnUI?.destroy(); } catch { /* isolate */ }
    // Teardown each channel's renderers (timers, pinned messages, etc.).
    for (const c of entry.channels) {
      try { await c.todo.teardown(); } catch { /* isolate */ }
      try { await c.header.teardown(); } catch { /* isolate */ }
      try { await c.activity.teardown(); } catch { /* isolate */ }
      try { await c.agent.teardown(); } catch { /* isolate */ }
    }
  }

  // ---- TL_NEW_UX dispatch path --------------------------------------------

  private async dispatchNewUx(sessionId: string, ev: NotificationEvent, entry: SessionEntry): Promise<void> {
    const primaryTargets = entry.channels
      .filter(c => c.target.role === 'primary')
      .map(c => c.target);
    if (primaryTargets.length === 0) return;

    const adaptersByKey = new Map<string, PlatformAdapter>();
    for (const c of entry.channels) {
      if (c.target.role !== 'primary') continue;
      adaptersByKey.set(renderTargetKey(c.target), c.adapter);
    }

    const factory: HudPanelFactory = (target) => {
      const adapter = adaptersByKey.get(renderTargetKey(target));
      if (!adapter) throw new Error(`dispatchNewUx: no adapter for target ${renderTargetKey(target)}`);
      if (target.channelType === 'feishu') return new FeishuHudPanel(adapter, target);
      if (target.channelType === 'discord') {
        // TODO: T4 only built telegram + feishu HUD panels. Discord primaries
        // would mis-render <pre><code> blocks. Fail loudly until a panel exists.
        throw new Error('TurnUI: discord HUD panel not implemented');
      }
      return new TelegramHudPanel(adapter, target);
    };

    if (ev.kind === 'turn_start') {
      entry.activeTurnUI?.destroy();
      entry.turnCounter = (entry.turnCounter ?? 0) + 1;
      const initState = this.buildInitialHudState(sessionId, entry);
      entry.activeTurnUI = new TurnUI(initState, primaryTargets, factory);
      await entry.activeTurnUI.start();
      // Reset reply renderers and accumulator for the fresh turn.
      // Both primary and mirror targets get renderers: mirrors echo assistant text (spec §I5).
      entry.replyRenderers = new Map<string, ReplyRenderer>();
      entry.replyAcc = '';
      for (const c of entry.channels) {
        if (c.target.role !== 'primary' && c.target.role !== 'mirror') continue;
        entry.replyRenderers.set(renderTargetKey(c.target), new ReplyRenderer(c.adapter, c.target));
      }
    }

    if (entry.activeTurnUI) {
      await entry.activeTurnUI.ingestEvent(ev);
    }

    // Dispatch assistant text events to reply renderers.
    // assistant_text_delta carries only the new portion (diff); accumulate first.
    if (entry.replyRenderers && entry.replyRenderers.size > 0) {
      if (ev.kind === 'assistant_text_delta') {
        entry.replyAcc = (entry.replyAcc ?? '') + ev.text;
        for (const r of entry.replyRenderers.values()) {
          await r.onTextDelta(entry.replyAcc);
        }
      } else if (ev.kind === 'assistant_text') {
        for (const r of entry.replyRenderers.values()) {
          await r.onTextComplete(ev.text);
        }
        entry.replyAcc = '';
      }
    }
  }

  private buildInitialHudState(sessionId: string, entry: SessionEntry): HudState {
    const session = this.opts.sessionManager.get(sessionId);
    const workspace = this.opts.workspaceManager.get(entry.workspaceId);
    const provider = session?.provider === 'codex' ? 'codex' : 'claude';
    // TODO(T10): drop `entry.channels[0]?.session.workspaceName` fallback when
    // legacy ChannelRenderers are removed; rely on workspaceManager.get(...).name only.
    const workspaceName = workspace?.name
      ?? entry.channels[0]?.session.workspaceName
      ?? entry.workspaceId;
    return initialHudState({
      sessionShortId: sessionId.slice(0, 7),
      workspaceName,
      // gitBranch: not exposed on Workspace (only gitRemote) — deferred to later wiring.
      provider,
      model: workspace?.defaults.model ?? 'unknown',
      // TODO: hardcoded 200_000 until a model→max-context table lands. The HUD
      // copes with stale numbers (Context bar just shows wrong percentage).
      modelMaxContext: 200_000,
      turnNumber: entry.turnCounter ?? 1,
      startedAtMs: Date.now(),
      costSession: session?.cost.totalCost ?? 0,
    });
  }

  // ---- Event dispatch -----------------------------------------------------

  private async handleSessionEvent(sessionId: string, ev: NotificationEvent): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    const channels = entry.channels;
    const state = channels[0]?.session;
    if (!state) return;

    if (process.env.TL_NEW_UX === '1') {
      await this.dispatchNewUx(sessionId, ev, entry);
      return;
    }

    // Trace dispatch for non-noop kinds so daemon.log shows the path.
    if (!isFrontendNoopKind(ev.kind)) {
      this.opts.logger?.info('frontend dispatch', { sessionId, kind: ev.kind });
    }

    switch (ev.kind) {
      case 'turn_start': {
        state.turn = newTurnRenderState(ev.turnId, ev.at, 0);
        for (const c of channels) { await c.activity.onEvent(ev); }
        // Reaction anchor: upgrade 👁️ → ⏳ on the most-recent inbound for each channel.
        for (const c of channels) {
          const inbound = c.session.lastInboundByTarget.get(targetKey(c.target));
          if (!inbound) continue;
          try { await c.reaction.setPhase(inbound, 'processing'); }
          catch (err) {
            this.opts.logger?.warn('reaction processing failed', {
              sessionId, channelType: c.target.channelType, reason: (err as Error).message,
            });
          }
        }
        return;
      }
      case 'turn_end': {
        // Capture turn stats on the turn render-state BEFORE we tear it down
        // so the assistant-message renderer can stamp a footer line with
        // tool counts + tokens + cost + duration on its final flush.
        if (state.turn) {
          state.turn.lastTurnStats = {
            durationMs: ev.durationMs ?? 0,
            costUsd: ev.costUsd ?? 0,
            tokensIn: ev.tokensIn ?? 0,
            tokensOut: ev.tokensOut ?? 0,
          };
        }
        // Accumulate cost so the session header reflects true running total.
        state.costUsd = (state.costUsd ?? 0) + (ev.costUsd ?? 0);
        for (const c of channels) { await c.activity.onEvent(ev); await c.agent.onEvent(ev); }
        for (const c of channels) { await c.header.refresh(); }
        // Reaction anchor: 🤔 → 👌. Fire-and-forget with a 400ms buffer so
        // Telegram's separate push channel for reactions doesn't beat the
        // bot's reply text to the user's client. Without the buffer users
        // could see the "completed" reaction before the actual reply
        // appears (the two are independent server pushes; no API ordering
        // guarantee). 400ms is empirical — long enough to win the race in
        // typical conditions, short enough that the reaction transition
        // still feels responsive.
        const turnEndAt = Date.now();
        const inbounds: Array<{ c: ChannelRenderers; inbound: { chatId: string; messageId: string; threadId?: string } }> = [];
        for (const c of channels) {
          const inbound = c.session.lastInboundByTarget.get(targetKey(c.target));
          if (inbound) inbounds.push({ c, inbound });
        }
        if (inbounds.length > 0) {
          void (async () => {
            const elapsed = Date.now() - turnEndAt;
            const remaining = Math.max(0, 400 - elapsed);
            if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
            for (const { c, inbound } of inbounds) {
              try { await c.reaction.setPhase(inbound, 'done_ok'); }
              catch (err) {
                this.opts.logger?.warn('reaction done_ok failed', {
                  sessionId, channelType: c.target.channelType, reason: (err as Error).message,
                });
              }
            }
          })();
        }
        state.turn = undefined;
        return;
      }
      case 'status_change': {
        // Fold status into header refresh only (turns handled by phase-specific events).
        for (const c of channels) { await c.header.refresh(); }
        return;
      }
      case 'assistant_text_delta':
      case 'assistant_text':
        for (const c of channels) { await c.agent.onEvent(ev); }
        return;
      case 'tool_use_start': {
        if (state.turn) {
          state.turn.currentTool = ev.toolName;
          state.turn.parallelTools.set(ev.toolUseId, {
            toolUseId: ev.toolUseId,
            toolName: ev.toolName,
            status: 'running',
            batchIndex: ev.batchIndex,
          });
          // Bump per-tool invocation count for the assistant-message footer.
          const prev = state.turn.toolUseCounts.get(ev.toolName) ?? 0;
          state.turn.toolUseCounts.set(ev.toolName, prev + 1);
        }
        for (const c of channels) { await c.activity.onEvent(ev); }
        return;
      }
      case 'tool_use_result': {
        if (state.turn) {
          const existing = state.turn.parallelTools.get(ev.toolUseId);
          if (existing) existing.status = ev.ok ? 'done_ok' : 'done_err';
          // Clear currentTool when the last running tool completes.
          const anyRunning = [...state.turn.parallelTools.values()].some((t) => t.status === 'running');
          if (!anyRunning) state.turn.currentTool = undefined;
        }
        for (const c of channels) { await c.activity.onEvent(ev); }
        return;
      }
      case 'parallel_tool_batch_start':
      case 'parallel_tool_batch_end':
        for (const c of channels) { await c.activity.onEvent(ev); }
        return;
      case 'subagent_start': {
        if (state.turn) {
          state.turn.subagents.set(ev.agentId, {
            agentId: ev.agentId,
            description: ev.description,
            done: false,
            ok: null,
          });
        }
        for (const c of channels) { await c.activity.onEvent(ev); }
        return;
      }
      case 'subagent_progress': {
        if (state.turn) {
          const ent = state.turn.subagents.get(ev.agentId);
          if (ent) ent.latestSummary = ev.summary;
        }
        for (const c of channels) { await c.activity.onEvent(ev); }
        return;
      }
      case 'subagent_stop': {
        if (state.turn) {
          const ent = state.turn.subagents.get(ev.agentId);
          if (ent) { ent.done = true; ent.ok = ev.ok; }
        }
        for (const c of channels) { await c.activity.onEvent(ev); }
        return;
      }
      case 'todo_write':
        for (const c of channels) { await c.todo.update(ev.items); }
        return;
      case 'attachment_produced':
        for (const c of channels) {
          await c.attachment.onProduced({
            attachmentId: ev.attachmentId,
            name: ev.name,
            mime: ev.mime,
            sizeBytes: ev.sizeBytes,
            path: ev.path,
          });
        }
        return;
      case 'prompt_suggestion':
        if (state.turn) state.turn.promptSuggestions = ev.suggestions;
        for (const c of channels) { await c.activity.onEvent(ev); }
        return;
      case 'cache_warmth_change':
        state.cacheWarmUntilMs = ev.warmUntilMs;
        for (const c of channels) { await c.header.refresh(); }
        return;
      case 'session_complete': {
        await this.detachSession(sessionId);
        return;
      }
      case 'runtime_error': {
        // Still flush the activity sticky so the user sees any fault banner.
        if (state.turn) {
          for (const c of channels) { await c.activity.onEvent(ev); }
        }
        // Reaction anchor: 💔 for runtime errors. Soft-faults (warn severity)
        // also upgrade the reaction so users see something failed; the warn
        // banner from activity-sticky carries the diagnostic. Same 400ms
        // buffer as done_ok so any error-banner activity render lands first.
        const errAt = Date.now();
        const errInbounds: Array<{ c: ChannelRenderers; inbound: { chatId: string; messageId: string; threadId?: string } }> = [];
        for (const c of channels) {
          const inbound = c.session.lastInboundByTarget.get(targetKey(c.target));
          if (inbound) errInbounds.push({ c, inbound });
        }
        if (errInbounds.length > 0) {
          void (async () => {
            const elapsed = Date.now() - errAt;
            const remaining = Math.max(0, 400 - elapsed);
            if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
            for (const { c, inbound } of errInbounds) {
              try { await c.reaction.setPhase(inbound, 'done_err'); }
              catch (err) {
                this.opts.logger?.warn('reaction done_err failed', {
                  sessionId, channelType: c.target.channelType, reason: (err as Error).message,
                });
              }
            }
          })();
        }
        return;
      }
      // Known noop kinds — these events are consumed elsewhere in the pipeline
      // (runtime, brokers, cost tracker) and have no direct UI in T6.
      case 'heartbeat':
      case 'thinking_delta':
      case 'thinking_end':
      case 'subagent_event':
      case 'file_changed':
      case 'ask_user_question_requested':
      case 'ask_user_question_resolved':
      case 'elicitation_requested':
      case 'elicitation_resolved':
      case 'permission_requested':
      case 'permission_resolved':
      case 'pre_compact':
      case 'post_compact':
      case 'prewarm_tick':
      case 'api_throttle':
      case 'api_resumed':
      case 'rewind_files':
      case 'session_forked':
      case 'session_renamed':
      case 'mcp_status_change':
      case 'plugin_reloaded':
      case 'hook_generic':
        return;
      // quota_update — consumed by the HUD layer (T4); noop in legacy path.
      case 'quota_update':
        return;
      default:
        // Compile-time exhaustiveness: if a new NotificationEvent kind is added,
        // TypeScript will complain here. At runtime we just log-and-noop.
        assertNever(ev);
        // eslint-disable-next-line no-console
        console.debug('[SessionFrontend] unhandled event', (ev as { kind: string }).kind);
        return;
    }
  }

  private async handlePermissionEvent(ev: BrokerEvent): Promise<void> {
    const entry = this.sessions.get(ev.sessionId);
    if (!entry) return;
    if (ev.kind === 'pending') {
      for (const c of entry.channels) { await c.permission.onPending(ev.request); }
    } else {
      for (const c of entry.channels) { await c.permission.onResolved(ev.requestId, ev.decision, ev.resolvedByUserId); }
    }
  }

  private async handleAskEvent(ev: AskBrokerEvent): Promise<void> {
    const entry = this.sessions.get(ev.sessionId);
    if (!entry) return;
    if (ev.kind === 'pending') {
      // Render as a generic permission-style card with per-option buttons.
      for (const c of entry.channels) {
        const buttons = ev.request.options.map((opt, i) => [
          { text: opt, callbackData: `ask:${ev.request.id}:${i}` },
        ]);
        const target = c.target;
        const effective = target.role === 'primary' ? { type: 'inline_keyboard' as const, buttons } : undefined;
        const msgId = await c.adapter.send({
          chatId: target.chatId,
          threadId: target.threadId,
          text: `❓ ${ev.request.prompt}`,
          replyMarkup: effective,
        });
        const state = c.session;
        const key = targetKey(target);
        let perTarget = state.pendingAskMsgIds.get(key);
        if (!perTarget) { perTarget = new Map(); state.pendingAskMsgIds.set(key, perTarget); }
        perTarget.set(ev.request.id, msgId);
      }
    } else {
      // resolved
      for (const c of entry.channels) {
        const target = c.target;
        const key = targetKey(target);
        const msgId = c.session.pendingAskMsgIds.get(key)?.get(ev.requestId);
        if (!msgId) continue;
        try {
          await c.adapter.edit(msgId, target.chatId, `✅ Chosen: ${ev.chosen.join(', ')}`, { type: 'inline_keyboard', buttons: [] });
        } catch { /* isolate */ }
        c.session.pendingAskMsgIds.get(key)?.delete(ev.requestId);
      }
    }
  }

  private async handleElicitationEvent(ev: ElicitationBrokerEvent): Promise<void> {
    const entry = this.sessions.get(ev.sessionId);
    if (!entry) return;
    if (ev.kind === 'pending') {
      for (const c of entry.channels) { await c.elicitation.onPending(ev.request); }
    } else {
      for (const c of entry.channels) { await c.elicitation.onResolved(ev.requestId, ev.result.action); }
    }
  }
}

// Avoid unused-import warnings for TurnRenderState (exposed for tests via types).
export type { TurnRenderState };
