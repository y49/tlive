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
//
// T10b: Legacy renderers (session-header, activity-sticky, agent-message,
// todo-sticky, permission-card-legacy, attachment-preview-legacy, queue-hint)
// have been deleted. TL_NEW_UX gate removed — new UX path is now the only path.

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
  type RenderTarget,
  targetKey,
} from './render/types.js';
import { ReactionTracker } from './reaction-tracker.js';
import { ElicitationFormRenderer } from './elicitation/form.js';
import { TurnUI, type HudPanelFactory } from './turn-ui.js';
import { TelegramHudPanel } from './hud/telegram-panel.js';
import { FeishuHudPanel } from './hud/feishu-panel.js';
import { initialHudState, type HudState } from './hud/state.js';
import { targetKey as renderTargetKey } from './render-target.js';
import { ReplyRenderer } from './reply.js';
import { AttachmentPreview } from './attachment.js';
import { PermissionCard } from './permission/card.js';
import { TurnComposite } from './turn-composite.js';
import { EditQueue } from './reply-document/edit-queue.js';

/**
 * A renderer set lives per (session, binding). The set's adapter is the one
 * for that channel only; every renderer inside operates on `target` alone.
 */
interface ChannelRenderers {
  channelType: ChannelType;
  adapter: PlatformAdapter;
  target: RenderTarget;
  session: SessionRenderState;
  reaction: ReactionTracker;
  elicitation: ElicitationFormRenderer;
}

interface SessionEntry {
  sessionId: string;
  workspaceId: string;
  unsubscribeEvent: () => void;
  channels: ChannelRenderers[];
  /** Per-turn HUD ownership. Replaced on each turn_start. */
  activeTurnUI?: TurnUI;
  /** Per-turn counter for HUD header display. */
  turnCounter?: number;
  /** Per-turn reply renderers, keyed by targetKey. Reset on turn_start. */
  replyRenderers?: Map<string, ReplyRenderer>;
  /**
   * Accumulated assistant text across deltas for the current turn.
   * assistant_text_delta carries only the new portion (diff, partial:true); we
   * accumulate here so ReplyRenderer receives the full text on each call.
   * Reset to '' on turn_start.
   */
  replyAcc?: string;
  /** Active AskUserQuestion cards keyed by requestId. */
  activeAskCards?: Map<string, PermissionCard>;
  /** Per-chatId pending custom-input cards for plaintext relay. */
  pendingCustomInputCards?: Map<string, PermissionCard>;
  /** Active generic-permission cards keyed by requestId. */
  activePermCards?: Map<string, PermissionCard>;
  /** Generic permission cards waiting for plaintext fallback resolution (per chatId). */
  pendingPermPlaintextCards?: Map<string, PermissionCard>;
  /**
   * Per-session promise chain to serialize handleSessionEvent invocations.
   * SDK fires events in order, but the onEvent callback is fire-and-forget.
   * Without this chain, two assistant_text_delta would race in
   * ReplyRenderer.renderTelegram (both see headMsgId === null and both
   * `send`, producing duplicate IM messages).
   */
  dispatchChain: Promise<void>;
  /** v2: per-turn TurnComposite + EditQueue per channel target. */
  activeTurnComposites?: Map<string, TurnComposite>;
  editQueues?: Map<string, EditQueue>;
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


export class SessionFrontend {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;
  /** Flat reqId → card index for O(1) callback routing across all sessions. */
  private readonly cardsByReqId = new Map<string, PermissionCard>();
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

    // Per-adapter inbound interceptor for PermissionCard callback format
    // (ask:<reqId>:opt:<n>, ask:<reqId>:confirm, ask:<reqId>:custom) and
    // for plaintext relay to pending custom-input cards.
    for (const adapter of Object.values(this.opts.adapters)) {
      if (!adapter) continue;
      this.unsubscribers.push(
        adapter.onInbound((inbound) => {
          if (inbound.kind === 'callback' && inbound.callbackData) {
            void this.routeCallback(inbound.callbackData).catch(() => { /* isolate */ });
            return;
          }
          if (inbound.kind === 'message' && typeof inbound.text === 'string') {
            void this.routePlaintext(inbound.chatId, inbound.text).catch(() => { /* isolate */ });
          }
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
        elicitation: new ElicitationFormRenderer({ ...deps, session: renderState }),
      };
      channels.push(channel);
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

    const entry: SessionEntry = {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      unsubscribeEvent: () => { /* set below */ },
      channels,
      dispatchChain: Promise.resolve(),
    };
    const unsubscribeEvent = session.onEvent((ev) => {
      entry.dispatchChain = entry.dispatchChain
        .then(() => this.handleSessionEvent(session.id, ev))
        .catch(() => { /* isolate */ });
    });
    entry.unsubscribeEvent = unsubscribeEvent;
    this.sessions.set(session.id, entry);
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
    if (entry.activeTurnComposites) {
      for (const tc of entry.activeTurnComposites.values()) {
        try { tc.destroy(); } catch { /* isolate */ }
      }
    }
    if (entry.activePermCards) {
      for (const reqId of entry.activePermCards.keys()) this.cardsByReqId.delete(reqId);
    }
    if (entry.activeAskCards) {
      for (const reqId of entry.activeAskCards.keys()) this.cardsByReqId.delete(reqId);
    }
    if (entry.pendingPermPlaintextCards) entry.pendingPermPlaintextCards.clear();
  }

  // ---- Event dispatch -----------------------------------------------------

  private buildInitialHudState(sessionId: string, entry: SessionEntry): HudState {
    const session = this.opts.sessionManager.get(sessionId);
    const workspace = this.opts.workspaceManager.get(entry.workspaceId);
    const provider = session?.provider === 'codex' ? 'codex' : 'claude';
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

  private async handleSessionEvent(sessionId: string, ev: NotificationEvent): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    // ---- Reaction phases (per-channel) ------------------------------------
    if (ev.kind === 'turn_start') {
      for (const c of entry.channels) {
        const inbound = c.session.lastInboundByTarget.get(targetKey(c.target));
        if (!inbound) continue;
        try { await c.reaction.setPhase(inbound, 'processing'); }
        catch (err) {
          this.opts.logger?.warn('reaction processing failed', {
            sessionId, channelType: c.target.channelType, reason: (err as Error).message,
          });
        }
      }
    } else if (ev.kind === 'turn_end') {
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
      for (const c of entry.channels) {
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
    } else if (ev.kind === 'runtime_error') {
      // Reaction anchor: 💔 for runtime errors. Same 400ms buffer as done_ok
      // so any TurnUI error-banner render lands first.
      const errAt = Date.now();
      const errInbounds: Array<{ c: ChannelRenderers; inbound: { chatId: string; messageId: string; threadId?: string } }> = [];
      for (const c of entry.channels) {
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
    }

    // ---- TurnUI / HUD dispatch ---------------------------------------------

    const primaryTargets = entry.channels
      .filter(c => c.target.role === 'primary')
      .map(c => c.target);

    if (primaryTargets.length > 0) {
      const adaptersByKey = new Map<string, PlatformAdapter>();
      for (const c of entry.channels) {
        if (c.target.role !== 'primary') continue;
        adaptersByKey.set(renderTargetKey(c.target), c.adapter);
      }
      const factory: HudPanelFactory = (target) => {
        const adapter = adaptersByKey.get(renderTargetKey(target));
        if (!adapter) throw new Error(`handleSessionEvent: no adapter for target ${renderTargetKey(target)}`);
        if (target.channelType === 'feishu') return new FeishuHudPanel(adapter, target);
        if (target.channelType === 'discord') {
          // TODO: Discord HUD panel not yet implemented; fail loudly until it is.
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

        // v2 dual-path: build TurnComposite alongside the v1 TurnUI/ReplyRenderer
        // wiring. v1 path stays active until T9 cleanup; smoke can compare both
        // layouts. EditQueue persists across turns (rate-limit state belongs to
        // the chat, not the turn) so we cache it on the SessionEntry.
        if (entry.activeTurnComposites) {
          for (const tc of entry.activeTurnComposites.values()) tc.destroy();
        }
        entry.activeTurnComposites = new Map<string, TurnComposite>();
        if (!entry.editQueues) entry.editQueues = new Map<string, EditQueue>();
        for (const c of entry.channels) {
          if (c.target.role !== 'primary') continue;
          const tk = renderTargetKey(c.target);
          let eq = entry.editQueues.get(tk);
          if (!eq) {
            const eqOpts = c.target.channelType === 'telegram'
              ? { refillMs: 2000, capacity: 5 }
              : { refillMs: 100, capacity: 50 };
            eq = new EditQueue(eqOpts);
            entry.editQueues.set(tk, eq);
          }
          const tc = new TurnComposite(c.adapter, c.target, eq, initState);
          entry.activeTurnComposites.set(tk, tc);
          void tc.start();
        }
      }

      if (entry.activeTurnUI) {
        await entry.activeTurnUI.ingestEvent(ev);
      }

      // v2 dual-path: broadcast every event to all live TurnComposites. v1
      // continues to render the legacy HUD panel + ReplyRenderer in parallel
      // (T9 deletes v1 once smoke confirms v2 layout).
      if (entry.activeTurnComposites) {
        for (const tc of entry.activeTurnComposites.values()) {
          if (!tc.isDestroyed()) tc.ingestEvent(ev);
        }
      }
    }

    // ---- Reply / attachment dispatch ----------------------------------------

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

    // Dispatch attachment previews to primary targets only (mirrors get text
    // echoes but not file previews per spec §I5).
    if (ev.kind === 'attachment_produced') {
      for (const c of entry.channels) {
        if (c.target.role !== 'primary') continue;
        const ap = new AttachmentPreview(c.adapter, c.target);
        await ap.send({ name: ev.name, mime: ev.mime, sizeBytes: ev.sizeBytes, path: ev.path });
      }
    }

    // ---- Session lifecycle --------------------------------------------------
    if (ev.kind === 'session_complete') {
      await this.detachSession(sessionId);
    }

    // All remaining event kinds are either consumed by TurnUI.ingestEvent above
    // or are noop at the frontend layer (consumed by runtime, brokers, cost
    // tracker elsewhere). Compile-time exhaustiveness is enforced by TurnUI's
    // reducer; we don't need a full switch here.
  }

  private async handlePermissionEvent(ev: BrokerEvent): Promise<void> {
    const entry = this.sessions.get(ev.sessionId);
    if (!entry) return;
    if (!entry.activePermCards) entry.activePermCards = new Map<string, PermissionCard>();

    if (ev.kind === 'pending') {
      const req = ev.request;
      // Tools that should NOT reach the generic 4-button permission flow:
      // - AskUserQuestion / ExitPlanMode are intercepted upstream by Claude SDK
      //   PreToolUse hooks (src/runtime/claude/ask-hook.ts). If we still see
      //   them here it means the hook didn't fire — auto-deny is safer than
      //   showing the user a generic Allow/Deny card for an unanswerable tool.
      const HOOKED_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
      if (HOOKED_TOOLS.has(req.toolName)) {
        process.stderr.write(
          `[frontend] ${req.toolName} reached permissionBroker; PreToolUse hook missed. ` +
          `Auto-denying so the agent doesn't render a generic permission card.\n`,
        );
        this.opts.permissionBroker.resolve(ev.sessionId, req.id, 'deny');
        return;
      }
      for (const c of entry.channels) {
        if (c.target.role !== 'primary') continue;
        const card = new PermissionCard(c.adapter, c.target, {
          kind: 'generic',
          requestId: req.id,
          toolName: req.toolName,
          toolInput: req.toolInput,
          onResolve: (decision) => {
            // PermissionCard uses 'always'; broker expects 'allow_always'.
            const brokerDecision = decision === 'always' ? 'allow_always' : decision;
            this.opts.permissionBroker.resolve(ev.sessionId, req.id, brokerDecision);
          },
        });
        await card.send();
        entry.activePermCards.set(req.id, card);
        this.cardsByReqId.set(req.id, card);
        if (card.isPermFallbackPending()) {
          if (!entry.pendingPermPlaintextCards) entry.pendingPermPlaintextCards = new Map<string, PermissionCard>();
          entry.pendingPermPlaintextCards.set(c.target.chatId, card);
        }
      }
      return;
    }

    if (ev.kind === 'resolved') {
      entry.activePermCards.delete(ev.requestId);
      this.cardsByReqId.delete(ev.requestId);
      if (entry.pendingPermPlaintextCards) {
        for (const [chatId, c] of [...entry.pendingPermPlaintextCards.entries()]) {
          if (c.requestId === ev.requestId) entry.pendingPermPlaintextCards.delete(chatId);
        }
      }
      return;
    }
  }

  private async handleAskEvent(ev: AskBrokerEvent): Promise<void> {
    const entry = this.sessions.get(ev.sessionId);
    if (!entry) return;
    if (!entry.activeAskCards) entry.activeAskCards = new Map<string, PermissionCard>();
    if (!entry.pendingCustomInputCards) entry.pendingCustomInputCards = new Map<string, PermissionCard>();

    if (ev.kind === 'pending') {
      // Determine mode from request shape. AskUserQuestionRequest has multiSelect?:boolean
      // but no allowCustom — custom-input mode is deferred until the broker exposes the flag.
      const req = ev.request;
      const mode: 'single' | 'multi' | 'custom-input' = req.allowCustom
        ? 'custom-input'
        : req.multiSelect ? 'multi' : 'single';

      for (const c of entry.channels) {
        if (c.target.role !== 'primary') continue;
        const card = new PermissionCard(c.adapter, c.target, {
          kind: 'ask',
          requestId: req.id,
          mode,
          question: req.prompt,
          header: req.header,
          options: req.options,
          onResolve: (chosen) => {
            this.opts.askBroker?.resolve(ev.sessionId, req.id, chosen);
            entry.pendingCustomInputCards?.delete(c.target.chatId);
          },
        });
        await card.send();
        entry.activeAskCards.set(req.id, card);
        this.cardsByReqId.set(req.id, card);
      }
      return;
    }

    // resolved
    if (ev.kind === 'resolved') {
      entry.activeAskCards.delete(ev.requestId);
      this.cardsByReqId.delete(ev.requestId);
      if (entry.pendingCustomInputCards) {
        for (const [chatId, c] of [...entry.pendingCustomInputCards.entries()]) {
          if (c.requestId === ev.requestId) entry.pendingCustomInputCards.delete(chatId);
        }
      }
    }
  }

  private async routeCallback(data: string): Promise<void> {
    // AskUserQuestion cards: ask:<reqId>:... and generic permission cards: perm:<reqId>:...
    // O(1) lookup via flat cardsByReqId index (populated by handlePermissionEvent /
    // handleAskEvent; cleaned up on resolved and detachSession).
    const m = data.match(/^(?:ask|perm):([^:]+):/);
    if (!m) return;
    const card = this.cardsByReqId.get(m[1]!);
    if (card) await card.handleCallback(data);
  }

  private async routePlaintext(chatId: string, text: string): Promise<void> {
    const trimmed = text.trim().toLowerCase();
    // Try generic permission keyword fallback first.
    for (const entry of this.sessions.values()) {
      const card = entry.pendingPermPlaintextCards?.get(chatId);
      if (!card || !card.isPermFallbackPending()) continue;
      const verb = parsePermissionKeyword(trimmed);
      if (verb) {
        await card.resolveFromKeyword(verb);
        entry.pendingPermPlaintextCards?.delete(chatId);
        return;
      }
    }
    // Existing custom-input handling.
    for (const entry of this.sessions.values()) {
      const card = entry.pendingCustomInputCards?.get(chatId);
      if (card && card.expectsPlaintextRelay()) {
        await card.resolveWithPlaintext(text);
        entry.pendingCustomInputCards?.delete(chatId);
        return;
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

function parsePermissionKeyword(s: string): 'allow' | 'deny' | 'always' | null {
  const allowSet = new Set(['allow', 'yes', 'y', '同意', '允许', '好', 'ok']);
  const denySet = new Set(['deny', 'no', 'n', '拒绝', '不', 'cancel']);
  const alwaysSet = new Set(['always', 'always allow', '始终', '始终允许']);
  if (allowSet.has(s)) return 'allow';
  if (denySet.has(s)) return 'deny';
  if (alwaysSet.has(s)) return 'always';
  return null;
}

