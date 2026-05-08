// src/im/frontend.ts
//
// SessionFrontend — v1.0 IM orchestrator (spec §7.1). Subscribes to the
// three layers that originate UI-bound state (SessionManager, PermissionBroker,
// AskUserQuestionBroker, ElicitationBroker) and dispatches each event to the
// right renderer(s). Maintains a RenderContext per session with per-anchor
// message-id book-keeping, and tears everything down on session stop.
//
// Platform targeting: per spec §3 chat-level isolation — each session has
// exactly one ownerChat (the chat that spawned it). attachSession takes
// (sessionId, workspaceId, ownerChat) and instantiates a SINGLE renderer
// bundle for the ownerChat. Fan-out across all workspace bindings is gone:
// other chats bound to the same workspace will not receive renders for this
// session (spec §5). Iso #7 strips the role-based filter loops that remain
// here from the v1 multi-binding implementation.
//
// T10b: Legacy renderers (session-header, activity-sticky, agent-message,
// todo-sticky, permission-card-legacy, attachment-preview-legacy, queue-hint)
// have been deleted. TL_NEW_UX gate removed — new UX path is now the only path.

import type { SessionManager } from '../session/manager.js';
import type { OwnerChat } from '../session/types.js';
import type { NotificationEvent } from '../runtime/events.js';
import type { PermissionBroker, BrokerEvent } from '../permission/broker.js';
import type { AskUserQuestionBroker, AskBrokerEvent } from '../permission/ask-broker.js';
import type { ElicitationBroker, ElicitationBrokerEvent } from '../permission/elicitation-broker.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { ChannelType } from '../workspace/chat-instance.js';
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
import { initialHudState, resolveModelLabel, type HudState } from './hud/state.js';
import { AttachmentPreview } from './attachment.js';
import { PermissionCard } from './permission/card.js';
import { TurnComposite } from './turn-composite.js';
import { EditQueue } from './reply-document/edit-queue.js';
import { AskCardController } from './ask/ask-card-controller.js';

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
  /** Chat that spawned this session (spec §3 + §5.1). Renders go here only. */
  ownerChat: OwnerChat;
  unsubscribeEvent: () => void;
  /** Single renderer bundle keyed off ownerChat (spec §5.1 — fan-out removed). */
  channel: ChannelRenderers;
  /** Per-turn counter for HUD header display. */
  turnCounter?: number;
  /** Active generic-permission cards keyed by requestId. */
  activePermCards?: Map<string, PermissionCard>;
  /** Generic permission card waiting for plaintext fallback resolution. Single
   *  card per session (one ownerChat → one pending card max). */
  pendingPermPlaintextCard?: PermissionCard;
  /**
   * Per-session promise chain to serialize handleSessionEvent invocations.
   * SDK fires events in order, but the onEvent callback is fire-and-forget.
   * Without this chain concurrent events could race when ingesting into the
   * TurnComposite / EditQueue pipeline.
   */
  dispatchChain: Promise<void>;
  /** Active TurnComposite + EditQueue for the single ownerChat target. */
  activeTurnComposite?: TurnComposite;
  editQueue?: EditQueue;
  /** AskCardController for the single ownerChat. */
  askController?: AskCardController;
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
          case 'registered': {
            const owner = ev.session.ownerChat;
            if (!owner) {
              this.opts.logger?.warn(
                'session attached without ownerChat — frontend skip (spec §5.1)',
                { sessionId: ev.session.id, kind: ev.kind },
              );
              return;
            }
            try {
              this.attachSession(ev.session.id, ev.session.workspaceId, owner, ev.session);
            } catch { /* isolate */ }
            break;
          }
          case 'stopped': {
            // Bump sessionCount on this chat's costRollup (spec §6.2).
            // Must read ownerChat BEFORE detachSession removes the entry.
            const stoppedEntry = this.sessions.get(ev.sessionId);
            if (stoppedEntry?.ownerChat) {
              const { channelType, chatId } = stoppedEntry.ownerChat;
              try {
                this.opts.workspaceManager.addCost(channelType, chatId, 0, true);
              } catch { /* isolate — wm may not have the chat instance */ }
            }
            void this.detachSession(ev.sessionId).catch(() => { /* isolate */ });
            break;
          }
        }
      }),
    );

    // PermissionBroker.
    this.unsubscribers.push(
      this.opts.permissionBroker.subscribe((ev) => {
        void this.handlePermissionEvent(ev).catch(() => { /* isolate */ });
      }),
    );

    // AskUserQuestionBroker → AskCardController.
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
    // (ask:<reqId>:opt:<n>, ask:<reqId>:confirm, ask:<reqId>:custom and
    // perm:<reqId>:<verb>) plus plaintext relay for fallback-pending generic
    // permission cards and custom-input ask cards.
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

  /** Test helper — expose renderer bundle for a session as a singleton list
   *  for backward compatibility with multi-channel test assertions. */
  getChannelsForTest(sessionId: string): ChannelRenderers[] | undefined {
    const entry = this.sessions.get(sessionId);
    return entry ? [entry.channel] : undefined;
  }

  // ---- Session attach / detach --------------------------------------------

  /**
   * Spec §5.2 — single-channel attach. session is the SessionLike whose
   * onEvent we subscribe to for forward dispatching. ownerChat is the only
   * render target; other workspace bindings do NOT get a renderer (spec §5).
   */
  private attachSession(
    sessionId: string,
    workspaceId: string,
    ownerChat: OwnerChat,
    session: { shortAlias: string; onEvent: (cb: (e: NotificationEvent) => void) => () => void },
  ): void {
    if (this.sessions.has(sessionId)) return;
    const adapter = this.opts.adapters[ownerChat.channelType];
    if (!adapter) {
      this.opts.logger?.warn('attachSession: no adapter for ownerChat', {
        sessionId, channelType: ownerChat.channelType,
      });
      return;
    }
    const workspace = this.opts.workspaceManager.get(workspaceId);
    const target: RenderTarget = {
      channelType: ownerChat.channelType,
      chatId: ownerChat.chatId,
      threadId: ownerChat.threadId,
      role: 'primary',
    };
    const renderState = newSessionRenderState({
      sessionId,
      shortAlias: session.shortAlias,
      workspaceId,
      workspaceName: workspace?.name ?? workspaceId,
      targets: [target],
    });
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

    // Apply any pending inbound that arrived BEFORE this session was attached:
    // bootstrap.handleInbound calls markInboundReceived right before
    // lazyResumeOrCreate, so by the time we see 'created' here the inbound
    // message id is parked in pendingInbound.
    const key = chatKey(channel.target.channelType, channel.target.chatId);
    const pending = this.pendingInbound.get(key);
    if (pending) {
      renderState.lastInboundByTarget.set(targetKey(channel.target), {
        chatId: channel.target.chatId,
        messageId: pending.messageId,
        threadId: pending.threadId,
      });
      this.pendingInbound.delete(key);
      void channel.reaction.setPhase(
        { chatId: channel.target.chatId, messageId: pending.messageId, threadId: pending.threadId },
        'received',
      ).catch((err) => {
        this.opts.logger?.warn('reaction received failed', {
          sessionId, channelType: channel.target.channelType,
          reason: (err as Error).message,
        });
      });
    }

    const entry: SessionEntry = {
      sessionId,
      workspaceId,
      ownerChat,
      unsubscribeEvent: () => { /* set below */ },
      channel,
      dispatchChain: Promise.resolve(),
    };
    const unsubscribeEvent = session.onEvent((ev) => {
      entry.dispatchChain = entry.dispatchChain
        .then(() => this.handleSessionEvent(sessionId, ev))
        .catch((err) => {
          this.opts.logger?.error('frontend dispatch failed', {
            sessionId, kind: ev.kind, err: (err as Error).message,
            stack: (err as Error).stack,
          });
        });
    });
    entry.unsubscribeEvent = unsubscribeEvent;
    this.sessions.set(sessionId, entry);
    this.opts.logger?.info('frontend attach', {
      sessionId, workspaceId,
      channelType: channel.target.channelType,
      chatId: channel.target.chatId,
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
    // Apply to every already-attached session whose ownerChat matches this chat.
    for (const entry of this.sessions.values()) {
      const c = entry.channel;
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

  private async detachSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    try { entry.unsubscribeEvent(); } catch { /* isolate */ }
    if (entry.activeTurnComposite) {
      try { entry.activeTurnComposite.destroy(); } catch { /* isolate */ }
    }
    if (entry.activePermCards) {
      for (const reqId of entry.activePermCards.keys()) this.cardsByReqId.delete(reqId);
    }
    entry.askController?.cancelPending();
    entry.pendingPermPlaintextCard = undefined;
  }

  // ---- Event dispatch -----------------------------------------------------

  private buildInitialHudState(sessionId: string, entry: SessionEntry): HudState {
    const session = this.opts.sessionManager.get(sessionId);
    const workspace = this.opts.workspaceManager.get(entry.workspaceId);
    const provider = session?.provider === 'codex' ? 'codex' : 'claude';
    const workspaceName = workspace?.name
      ?? entry.channel.session.workspaceName
      ?? entry.workspaceId;
    // Prefer the SDK-reported model (captured on system event during init —
    // before frontend subscribed) over the workspace default. resolveModelLabel
    // chains: sdk truth → workspace pref → 'claude-sonnet-4' fallback.
    return initialHudState({
      sessionShortId: sessionId.slice(0, 7),
      workspaceName,
      // gitBranch: not exposed on Workspace (only gitRemote) — deferred to later wiring.
      provider,
      model: resolveModelLabel(session?.sdkModel, workspace?.defaults.model, undefined),
      modelMaxContext: session?.sdkMaxContextTokens ?? 200_000,
      turnNumber: entry.turnCounter ?? 1,
      startedAtMs: Date.now(),
      costSession: session?.cost.totalCost ?? 0,
    });
  }

  private async handleSessionEvent(sessionId: string, ev: NotificationEvent): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.opts.logger?.info?.('frontend dispatch', { sessionId, kind: ev.kind });

    // ---- Reaction phases (single owner channel) -------------------------
    const c = entry.channel;
    if (ev.kind === 'turn_start') {
      const inbound = c.session.lastInboundByTarget.get(targetKey(c.target));
      if (inbound) {
        try { await c.reaction.setPhase(inbound, 'processing'); }
        catch (err) {
          this.opts.logger?.warn('reaction processing failed', {
            sessionId, channelType: c.target.channelType, reason: (err as Error).message,
          });
        }
      }
    } else if (ev.kind === 'turn_end') {
      // Accumulate per-turn cost into the chat's costRollup (spec §6.2).
      if (ev.costUsd > 0 && entry.ownerChat) {
        try {
          this.opts.workspaceManager.addCost(
            entry.ownerChat.channelType,
            entry.ownerChat.chatId,
            ev.costUsd,
            false,
          );
        } catch { /* isolate */ }
      }

      // Reaction anchor: 🤔 → 👌. Fire-and-forget with a 400ms buffer so
      // Telegram's separate push channel for reactions doesn't beat the
      // bot's reply text to the user's client. Without the buffer users
      // could see the "completed" reaction before the actual reply
      // appears (the two are independent server pushes; no API ordering
      // guarantee). 400ms is empirical — long enough to win the race in
      // typical conditions, short enough that the reaction transition
      // still feels responsive.
      const turnEndAt = Date.now();
      const inbound = c.session.lastInboundByTarget.get(targetKey(c.target));
      if (inbound) {
        void (async () => {
          const elapsed = Date.now() - turnEndAt;
          const remaining = Math.max(0, 400 - elapsed);
          if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
          try { await c.reaction.setPhase(inbound, 'done_ok'); }
          catch (err) {
            this.opts.logger?.warn('reaction done_ok failed', {
              sessionId, channelType: c.target.channelType, reason: (err as Error).message,
            });
          }
        })();
      }
    } else if (ev.kind === 'runtime_error') {
      // Reaction anchor: 💔 for runtime errors. Same 400ms buffer as done_ok
      // so any error-banner render lands first.
      const errAt = Date.now();
      const inbound = c.session.lastInboundByTarget.get(targetKey(c.target));
      if (inbound) {
        void (async () => {
          const elapsed = Date.now() - errAt;
          const remaining = Math.max(0, 400 - elapsed);
          if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
          try { await c.reaction.setPhase(inbound, 'done_err'); }
          catch (err) {
            this.opts.logger?.warn('reaction done_err failed', {
              sessionId, channelType: c.target.channelType, reason: (err as Error).message,
            });
          }
        })();
      }
    }

    // ---- TurnComposite / HUD dispatch (single owner channel) ---------------

    if (ev.kind === 'turn_start') {
      entry.turnCounter = (entry.turnCounter ?? 0) + 1;
      const initState = this.buildInitialHudState(sessionId, entry);

      // EditQueue persists across turns (rate-limit state belongs to the
      // chat, not the turn) so we cache it on the SessionEntry.
      if (entry.activeTurnComposite) entry.activeTurnComposite.destroy();
      if (!entry.editQueue) {
        const eqOpts = c.target.channelType === 'telegram'
          ? { refillMs: 2000, capacity: 5 }
          : { refillMs: 100, capacity: 50 };
        entry.editQueue = new EditQueue(eqOpts);
      }
      const tc = new TurnComposite(c.adapter, c.target, entry.editQueue, initState);
      entry.activeTurnComposite = tc;
      // Await placeholder send so msgId is set before subsequent events
      // (assistant_text_delta / turn_end) fire flushOnce — otherwise the
      // race causes flushOnce to short-circuit on null msgId, dropping the edit.
      await tc.start().catch((err) => {
        this.opts.logger?.error('TurnComposite.start failed', {
          sessionId, channelType: c.target.channelType, err: (err as Error).message,
        });
      });

      // Build AskCardController for the owner channel. Cancel any card
      // from the previous turn (turn boundary forgets pending questions).
      // The controller receives a broker-aware resolveFn so button clicks
      // land back in askBroker.resolve (cleans pending registry + emits
      // resolved).
      entry.askController?.cancelPending();
      entry.askController = new AskCardController(c.adapter, c.target, (reqId, chosen) => {
        this.opts.askBroker?.resolve(sessionId, reqId, chosen);
      });
    }

    // Broadcast every event to the live TurnComposite for HUD/reply update.
    if (entry.activeTurnComposite && !entry.activeTurnComposite.isDestroyed()) {
      entry.activeTurnComposite.ingestEvent(ev);
    }

    // ---- Attachment dispatch ------------------------------------------------

    if (ev.kind === 'attachment_produced') {
      const ap = new AttachmentPreview(c.adapter, c.target);
      await ap.send({ name: ev.name, mime: ev.mime, sizeBytes: ev.sizeBytes, path: ev.path });
    }

    // ---- Session lifecycle --------------------------------------------------
    if (ev.kind === 'session_complete') {
      await this.detachSession(sessionId);
    }

    // All other event kinds are consumed by TurnComposite.ingestEvent above or
    // are noop at the frontend layer (consumed by runtime, brokers, cost
    // tracker elsewhere).
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
      const c = entry.channel;
      const card = new PermissionCard(c.adapter, c.target, {
        kind: 'generic',
        requestId: req.id,
        toolName: req.toolName,
        toolInput: req.toolInput,
        category: req.category,
        diffPreview: req.diffPreview,
        risk: req.risk,
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
        entry.pendingPermPlaintextCard = card;
      }
      return;
    }

    if (ev.kind === 'resolved') {
      entry.activePermCards.delete(ev.requestId);
      this.cardsByReqId.delete(ev.requestId);
      if (entry.pendingPermPlaintextCard?.requestId === ev.requestId) {
        entry.pendingPermPlaintextCard = undefined;
      }
      return;
    }
  }

  private async handleAskEvent(ev: AskBrokerEvent): Promise<void> {
    const entry = this.sessions.get(ev.sessionId);
    if (!entry) return;

    if (ev.kind === 'pending') {
      const req = ev.request;
      const c = entry.channel;
      // Lazy init: askController is normally built on turn_start, but a
      // session can receive ask events outside any turn boundary (e.g. tests
      // or direct broker-driven prompts). Build the controller on demand so
      // we always have a destination for the card.
      if (!entry.askController) {
        entry.askController = new AskCardController(c.adapter, c.target, (reqId, chosen) => {
          this.opts.askBroker?.resolve(ev.sessionId, reqId, chosen);
        });
      }
      // v3.2.3: surface real errors instead of swallowing — pre-fix the
      // multi-select bug couldn't even be diagnosed because failures here
      // were silent.
      await entry.askController.open(req).catch((err) => {
        this.opts.logger?.error('askController.open failed', {
          sessionId: ev.sessionId, reqId: req.id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        });
      });
      const card = entry.askController.getCard(req.id);
      // Register in the flat reqId index so routeCallback can dispatch
      // ask:* callbacks.
      if (card) this.cardsByReqId.set(req.id, card);
      // v3.2.3: signal askPending to the active TurnComposite so the
      // banner switches to "❓ awaiting input" — without this it stays on
      // tool_running ("◐ AskUserQuestion") because tool_use_start fired first.
      if (entry.activeTurnComposite && !entry.activeTurnComposite.isDestroyed()) {
        entry.activeTurnComposite.replyDocument.setAskPending(true);
      }
      return;
    }

    if (ev.kind === 'resolved') {
      this.cardsByReqId.delete(ev.requestId);
      if (entry.askController?.has(ev.requestId)) {
        await entry.askController.markResolved(ev.requestId, ev.chosen).catch((err) => {
          this.opts.logger?.error('askController.markResolved failed', {
            sessionId: ev.sessionId, reqId: ev.requestId,
            err: (err as Error).message,
          });
        });
      }
      // Banner back to ◐ thinking after the user answered
      if (entry.activeTurnComposite && !entry.activeTurnComposite.isDestroyed()) {
        entry.activeTurnComposite.replyDocument.setAskPending(false);
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
    // Try generic permission keyword fallback first. Single pending card per
    // session — only matches when the session's ownerChat is this chat.
    for (const entry of this.sessions.values()) {
      if (entry.ownerChat.chatId !== chatId) continue;
      const card = entry.pendingPermPlaintextCard;
      if (!card || !card.isPermFallbackPending()) continue;
      const verb = parsePermissionKeyword(trimmed);
      if (verb) {
        await card.resolveFromKeyword(verb);
        entry.pendingPermPlaintextCard = undefined;
        return;
      }
    }
    // Custom-input plaintext relay for ask cards. Walk the ask controller
    // whose owner chat matches this chatId and offer the text to any card
    // expecting a plaintext relay (mode='custom-input').
    for (const entry of this.sessions.values()) {
      if (entry.ownerChat.chatId !== chatId) continue;
      const ctrl = entry.askController;
      if (!ctrl) continue;
      for (const card of ctrl.activeCards()) {
        if (card.expectsPlaintextRelay()) {
          await card.resolveWithPlaintext(text);
          return;
        }
      }
    }
  }

  private async handleElicitationEvent(ev: ElicitationBrokerEvent): Promise<void> {
    const entry = this.sessions.get(ev.sessionId);
    if (!entry) return;
    const c = entry.channel;
    if (ev.kind === 'pending') {
      await c.elicitation.onPending(ev.request);
    } else {
      await c.elicitation.onResolved(ev.requestId, ev.result.action);
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

