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
}

export interface SessionFrontendOptions {
  sessionManager: SessionManager;
  workspaceManager: WorkspaceManager;
  permissionBroker: PermissionBroker;
  askBroker?: AskUserQuestionBroker;
  elicitationBroker?: ElicitationBroker;
  /** Map of registered adapters keyed by channelType. */
  adapters: Partial<Record<ChannelType, PlatformAdapter>>;
}

/**
 * TypeScript exhaustiveness helper. Placing `assertNever(ev)` at the end of
 * a discriminated-union switch forces a compile error if a new kind is
 * added without a corresponding case.
 */
function assertNever(_x: never): void {
  /* nothing at runtime; `_x` should be unreachable */
}

export class SessionFrontend {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;

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
            void this.attachSession(ev.session).catch(() => { /* isolate */ });
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

  private async attachSession(session: SessionLike): Promise<void> {
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

    // Initialize session header for every channel (each owns its own msg id).
    for (const c of channels) {
      try { await c.header.initialize(); } catch { /* isolate */ }
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
  }

  private async detachSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    try { entry.unsubscribeEvent(); } catch { /* isolate */ }
    // Teardown each channel's renderers (timers, pinned messages, etc.).
    for (const c of entry.channels) {
      try { await c.todo.teardown(); } catch { /* isolate */ }
      try { await c.header.teardown(); } catch { /* isolate */ }
      try { await c.activity.teardown(); } catch { /* isolate */ }
      try { await c.agent.teardown(); } catch { /* isolate */ }
    }
  }

  // ---- Event dispatch -----------------------------------------------------

  private async handleSessionEvent(sessionId: string, ev: NotificationEvent): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    const channels = entry.channels;
    const state = channels[0]?.session;
    if (!state) return;

    switch (ev.kind) {
      case 'turn_start': {
        state.turn = newTurnRenderState(ev.turnId, ev.at, 0);
        for (const c of channels) { await c.activity.onEvent(ev); }
        return;
      }
      case 'turn_end': {
        // Accumulate cost so the session header reflects true running total.
        state.costUsd = (state.costUsd ?? 0) + (ev.costUsd ?? 0);
        for (const c of channels) { await c.activity.onEvent(ev); await c.agent.onEvent(ev); }
        for (const c of channels) { await c.header.refresh(); }
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
