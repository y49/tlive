// src/session/local-session.ts
//
// LocalSession — v1.0 daemon-owned session wrapping an AgentRuntime. Exposes
// the new SessionLike surface (shortAlias, onSessionIdReady broadcast,
// onStatusChange via the pure `transition()` folder, snapshot() → SessionInfo)
// and uses the prepare/attachSink lifecycle protocol.

import type {
  AgentRuntime, AgentRuntimeOptions, AgentProvider, PermissionRequest,
  AskUserQuestionRequest, ElicitationRequest,
} from '../runtime/types.js';
import type { NotificationEvent, UsageStats } from '../runtime/events.js';
import { SessionContext, type SessionContextSnapshot } from './context.js';
import type { SessionPersistence, SessionSnapshot } from './persistence.js';
import type { PermissionBroker } from '../permission/broker.js';
import type { AskUserQuestionBroker } from '../permission/ask-broker.js';
import type { ElicitationBroker } from '../permission/elicitation-broker.js';
import { CostTracker } from '../cost/tracker.js';
import type { AgentStatus } from './status.js';
import { transition } from './status.js';
import type { SessionInfo, SessionLike } from './types.js';
import { shortId } from '../util/short-id.js';
import { InputQueue } from './input-queue.js';
import { CacheWarmth } from './cache-warmth.js';
import { BudgetGuard } from './budget-guard.js';
import { CostRollupStore, dateKeyOf } from '../cost/rollups.js';

type LifecyclePhase = 'constructed' | 'prepared' | 'running' | 'terminated';

/** Legacy status used by bridge + v0.x tests. */
export type SessionStatus = 'starting' | 'active' | 'idle' | 'stopped';

export interface SessionInit {
  ctx: SessionContext;
  runtime: AgentRuntime;
  persistence: SessionPersistence;
  broker: PermissionBroker;
  /** Optional AskUserQuestion broker. When absent, ask requests are dropped
   *  (the runtime's own promise still resolves via 'decline' on stop). */
  askBroker?: AskUserQuestionBroker;
  /** Optional Elicitation broker. Same semantics as askBroker. */
  elicitationBroker?: ElicitationBroker;
  /** Optional budget cap in USD for this session. */
  maxBudgetUsd?: number;
  /**
   * Optional cross-session cost rollup store. When provided, every turn_end
   * appends a RollupDelta for the `/cost` dashboard. Must be shared across
   * sessions so per-day aggregation works.
   */
  rollupStore?: CostRollupStore;
}

/**
 * LocalSession — the concrete implementation of SessionLike for the Daemon
 * mode. Exposes the new v1.0 API (shortAlias, onEvent/onStatusChange/
 * onSessionIdReady, snapshot() → SessionInfo) and uses the 4-phase lifecycle
 * state machine (constructed → prepared → running → terminated).
 *
 * Scope boundary: PermissionBroker shape is unchanged from T1/T2. T4 splits
 * it into category-specific brokers; at that point this class will swap
 * the `handlePermission` body without API churn.
 */
export class LocalSession implements SessionLike {
  readonly kind = 'local' as const;
  readonly id: string;
  readonly shortAlias: string;
  readonly provider: AgentProvider;
  readonly workspaceId: string;
  readonly workdir: string;
  readonly ctx: SessionContext;
  title: string | undefined;
  readonly cost = new CostTracker();
  readonly queue = new InputQueue();
  readonly cacheWarmth = new CacheWarmth();

  // Internal state
  private runtime: AgentRuntime;
  private readonly persistence: SessionPersistence;
  private readonly broker: PermissionBroker;
  private readonly askBroker: AskUserQuestionBroker | null;
  private readonly elicitationBroker: ElicitationBroker | null;
  private readonly rollupStore: CostRollupStore | null;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly eventListeners = new Set<(e: NotificationEvent) => void>();
  private readonly statusListeners = new Set<(s: AgentStatus) => void>();
  private readonly sessionIdReadyListeners = new Set<(id: string) => void>();
  private readonly budgetGuard: BudgetGuard;
  private detached = false;
  private phase: LifecyclePhase = 'constructed';
  private readonly pendingSaves = new Set<Promise<void>>();
  get lifecyclePhase(): LifecyclePhase { return this.phase; }

  private history: NotificationEvent[] = [];
  private legacyStatus: SessionStatus = 'starting';
  private agentStatus: AgentStatus = { phase: 'initializing' };
  private readonly createdAt: number;
  private lastActivityAt: number;
  private abortCtrl = new AbortController();
  private _isReady = false;
  private _sdkModel?: string;
  private _sdkMaxContextTokens?: number;
  get sdkModel(): string | undefined { return this._sdkModel; }
  get sdkMaxContextTokens(): number | undefined { return this._sdkMaxContextTokens; }

  constructor(init: SessionInit) {
    this.ctx = init.ctx;
    this.runtime = init.runtime;
    this.persistence = init.persistence;
    this.broker = init.broker;
    this.askBroker = init.askBroker ?? null;
    this.elicitationBroker = init.elicitationBroker ?? null;
    this.rollupStore = init.rollupStore ?? null;
    this.id = init.ctx.snapshot.sessionId;
    this.shortAlias = shortId(this.id);
    this.provider = init.ctx.snapshot.provider;
    this.workspaceId = init.ctx.snapshot.workspaceId;
    this.workdir = init.ctx.snapshot.workdir;
    this.createdAt = init.ctx.snapshot.createdAt;
    this.lastActivityAt = this.createdAt;
    this.budgetGuard = new BudgetGuard(
      {
        getTotalCost: () => this.cost.totalCost,
        interrupt: () => this.interrupt(),
        emit: (e) => this.injectEvent(e),
      },
      { maxBudgetUsd: init.maxBudgetUsd },
    );
  }

  // ---- SessionLike surface --------------------------------------------------

  get status(): AgentStatus { return this.agentStatus; }
  set status(next: AgentStatus) {
    if (this.agentStatus === next) return;
    this.agentStatus = next;
    this.emitStatusChange(next);
  }
  get isReady(): boolean { return this._isReady; }

  onEvent(cb: (e: NotificationEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }
  onStatusChange(cb: (s: AgentStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }
  onSessionIdReady(cb: (id: string) => void): () => void {
    if (this._isReady) {
      // Fire synchronously for late subscribers; this matches hapi's ready-once semantics.
      try { cb(this.id); } catch { /* isolate */ }
      return () => undefined;
    }
    this.sessionIdReadyListeners.add(cb);
    return () => this.sessionIdReadyListeners.delete(cb);
  }

  snapshot(): SessionInfo {
    const c = this.cost.snapshot();
    return {
      id: this.id,
      shortAlias: this.shortAlias,
      kind: 'local',
      provider: this.provider,
      workspaceId: this.workspaceId,
      workdir: this.workdir,
      title: this.title,
      status: this.agentStatus,
      cost: {
        totalCost: c.costUsd,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        cacheReadTokens: c.cacheReadTokens ?? 0,
        cacheCreationTokens: c.cacheCreationTokens ?? 0,
      },
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  // ---- Legacy v0.x surface (bridge + old tests) -----------------------------

  get context(): SessionContextSnapshot { return this.ctx.snapshot; }
  getHistory(): readonly NotificationEvent[] { return this.history; }
  getStatus(): SessionStatus { return this.legacyStatus; }

  /** Legacy snapshot shape consumed by bridge + v0 tests. */
  snapshotLegacy(): SessionSnapshot {
    return {
      id: this.id,
      ctx: this.ctx.snapshot,
      status: this.legacyStatus,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      cost: this.cost.snapshot(),
      pendingPermissionIds: this.listPendingPermissions().map((r) => r.id),
    };
  }

  // ---- Lifecycle ------------------------------------------------------------

  async prepare(opts: Omit<AgentRuntimeOptions, 'workdir' | 'signal'> = {}): Promise<void> {
    if (this.phase !== 'constructed') throw new Error(`prepare from ${this.phase}`);
    await this.runtime.prepare({
      ...opts,
      workdir: this.ctx.snapshot.workdir,
      signal: this.abortCtrl.signal,
    });
    this._isReady = true;
    for (const cb of this.sessionIdReadyListeners) { try { cb(this.id); } catch { /* isolate */ } }
    this.sessionIdReadyListeners.clear();
    this.phase = 'prepared';
  }

  attachSink(): void {
    if (this.phase !== 'prepared') throw new Error(`attachSink from ${this.phase}`);
    this.runtime.attachSink({
      onEvent: (e) => this.handleEvent(e),
      onUsage: (u) => this.handleUsage(u),
      onPermissionRequest: (r) => this.handlePermission(r),
      onAskUserQuestion: (r) => this.handleAsk(r),
      onElicitation: (r) => this.handleElicitation(r),
    });
    this.setLegacyStatus('active');
    this.setAgentStatus({ phase: 'idle', queuedInputs: this.queue.size() });
    this.trackedSave();
    this.phase = 'running';
  }

  async sendInput(text: string, _source: 'im' | 'cli' = 'cli'): Promise<void> {
    if (this.legacyStatus === 'stopped') throw new Error('Session stopped');
    this.touch();
    await this.runtime.sendInput(text);
  }

  /** Increase the session budget cap by `extraUsd`; used by budget-override
   *  button flow (CallbackRouter). */
  extendBudget(extraUsd: number): void {
    this.budgetGuard.extend(extraUsd);
  }

  /** Read the current session budget cap (USD). undefined = no cap. */
  getMaxBudget(): number | undefined {
    return this.budgetGuard.cap;
  }

  /** Replace the session budget cap (USD). undefined disables the guard.
   *  Used by /budget command to mutate the cap BudgetGuard actually enforces. */
  setMaxBudget(usd: number | undefined): void {
    this.budgetGuard.setCap(usd);
  }

  async interrupt(): Promise<void> {
    if (this.legacyStatus === 'stopped') return;
    // Reject every pending request (permission / ask / elicitation) so any
    // canUseTool / askUserQuestion / elicit awaits unblock immediately.
    this.broker.denyAllForSession(this.id, 'interrupt');
    this.askBroker?.denyAllForSession(this.id, 'interrupt');
    this.elicitationBroker?.denyAllForSession(this.id, 'interrupt');
    try { await this.runtime.interrupt(); } catch { /* runtime may not support it */ }
    // Don't clobber a meaningful terminal phase set by BudgetGuard's
    // runtime_error emission ('errored') or an already-stopped session:
    // renderers rely on `code: 'budget_exceeded'` to show the override UI.
    const phase = this.agentStatus.phase;
    if (phase !== 'errored' && phase !== 'stopped') {
      this.setAgentStatus({ phase: 'interrupted', at: Date.now() });
    }
  }

  async stop(): Promise<void> {
    if (this.legacyStatus === 'stopped') return;
    this.abortCtrl.abort();
    for (const un of this.unsubscribers) un();
    this.unsubscribers.length = 0;
    this.broker.denyAllForSession(this.id, 'session_stopped');
    this.askBroker?.denyAllForSession(this.id, 'session_stopped');
    this.elicitationBroker?.denyAllForSession(this.id, 'session_stopped');
    if (!this.detached) {
      try { await this.runtime.stop(); } catch { /* already stopping */ }
    }
    this.cacheWarmth.dispose();
    this.setLegacyStatus('stopped');
    this.setAgentStatus({ phase: 'stopped' });
    await this.saveSnapshot();
    // Drain any in-flight tracked saves so callers awaiting stop() observe a
    // durably-persisted session. Each pendingSave already swallows its error.
    if (this.pendingSaves.size > 0) {
      await Promise.all([...this.pendingSaves]);
    }
    this.phase = 'terminated';
  }

  /**
   * Detach the underlying AgentRuntime from this session WITHOUT stopping it,
   * so SessionManager can park it in a WarmRuntimePool for reuse. The session
   * instance transitions to 'stopped' and must not receive further input —
   * subscriptions are unwired here so runtime-side events after detach don't
   * leak into the stopped session. Caller owns the returned runtime.
   *
   * Unused in T3; intended for T9+ when runtime.reset() lands. Until then,
   * SessionManager.stop() always calls stop() instead, because real runtimes
   * (Claude, Codex) throw on a second start().
   */
  detachRuntime(): AgentRuntime {
    if (this.detached) {
      throw new Error(`LocalSession(${this.id}): runtime already detached`);
    }
    this.detached = true;
    for (const un of this.unsubscribers) un();
    this.unsubscribers.length = 0;
    this.broker.denyAllForSession(this.id, 'runtime_detached');
    this.askBroker?.denyAllForSession(this.id, 'runtime_detached');
    this.elicitationBroker?.denyAllForSession(this.id, 'runtime_detached');
    this.cacheWarmth.dispose();
    this.setLegacyStatus('stopped');
    this.setAgentStatus({ phase: 'stopped' });
    // Snapshot is best-effort; detach must not await disk I/O to keep pool
    // transfer cheap. Persistence failures surface via their own logger.
    this.trackedSave();
    this.phase = 'terminated';
    return this.runtime;
  }

  // ---- Permission bridge ---------------------------------------------------

  resolvePermission(id: string, decision: 'allow' | 'deny' | 'allow_always', userId?: string): boolean {
    return this.broker.resolve(this.id, id, decision, userId);
  }

  listPendingPermissions(): PermissionRequest[] {
    return this.broker.pendingFor(this.id);
  }

  // ---- Runtime control face delegation (spec §4.2) --------------------------

  async setModel(model?: string): Promise<void> { await this.runtime.setModel(model); }
  async setPermissionMode(mode: Parameters<AgentRuntime['setPermissionMode']>[0]): Promise<void> {
    await this.runtime.setPermissionMode(mode);
  }
  async applyPermissionRules(rules: { allow?: string[]; deny?: string[] }): Promise<void> {
    await this.runtime.applyPermissionRules(rules);
  }
  async stopTask(id: string): Promise<void> { await this.runtime.stopTask(id); }
  async forkSession(title?: string): Promise<{ sdkSessionId: string }> { return this.runtime.forkSession(title); }
  async renameSession(title: string): Promise<void> {
    await this.runtime.renameSession(title);
    this.title = title;
  }
  async rewindFiles(userMessageId: string, opts?: { dryRun?: boolean }) {
    return this.runtime.rewindFiles(userMessageId, opts);
  }
  async reloadPlugins(): Promise<void> { await this.runtime.reloadPlugins(); }
  async setMcpServers(servers: Parameters<AgentRuntime['setMcpServers']>[0]) {
    return this.runtime.setMcpServers(servers);
  }
  async reconnectMcpServer(name: string): Promise<void> { await this.runtime.reconnectMcpServer(name); }
  async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    await this.runtime.toggleMcpServer(name, enabled);
  }

  // ---- Internal event handling ---------------------------------------------

  private handleEvent(event: NotificationEvent): void {
    this.touch();
    this.history.push(event);
    // Capture SDK init metadata onto the session so a late-attaching frontend
    // (which subscribes AFTER firstInitMessage has already fired) can still
    // read the real model + maxContext via session.sdkModel / sdkMaxContextTokens.
    if (event.kind === 'system') {
      this._sdkModel = event.model;
      this._sdkMaxContextTokens = event.maxContextTokens;
    }
    void this.persistence.appendEvent(this.id, event).catch(() => { /* surface via logger */ });
    this.emitEvent(event);

    // Fold into AgentStatus
    const next = transition(this.agentStatus, event);
    if (next !== this.agentStatus) this.setAgentStatus(next);

    // Fold into CostTracker on turn_end (spec §4.4)
    if (event.kind === 'turn_end') {
      this.cost.record({
        costUsd: event.costUsd,
        inputTokens: event.tokensIn,
        outputTokens: event.tokensOut,
      });
      // Persist a per-turn rollup delta so the /cost dashboard reflects usage
      // across sessions. Fire-and-forget: filesystem hiccups must not crash the
      // fold — rollup gaps are acceptable, turn-fold failures aren't.
      if (this.rollupStore) {
        const at = Date.now();
        void this.rollupStore.append({
          workspaceId: this.workspaceId,
          sdkSessionId: this.id,
          dateKey: dateKeyOf(at),
          deltaUsd: event.costUsd,
          deltaIn: event.tokensIn,
          deltaOut: event.tokensOut,
          at,
        }).catch(() => undefined);
      }
    }

    // Mark assistant response for cache warmth tracking
    if (event.kind === 'assistant_text') {
      this.cacheWarmth.markAssistantResponse();
    }

    // Legacy status mirror for bridge
    if (event.kind === 'session_complete' || event.kind === 'runtime_error') {
      this.setLegacyStatus('idle');
      this.trackedSave();
    }

    // Budget guard runs after cost update so totalCost is current
    this.budgetGuard.onEvent(event);
  }

  private handlePermission(req: PermissionRequest): void {
    this.touch();
    // Runtime stamped `req.id` as `${sdkSessionId}:${shortId}`; broker stores
    // it verbatim. PolicyStore auto-resolve may drop the request before any
    // listener sees it — that's deliberate (§5.4 of the spec). In that case
    // broker.issue returns false and we must NOT emit the legacy "pending
    // permission" event, because req.resolve() has already fired.
    this.broker.issue(this.id, this.workspaceId, req);
  }

  private handleAsk(req: AskUserQuestionRequest): void {
    this.touch();
    this.askBroker?.issue(this.id, req);
  }

  private handleElicitation(req: ElicitationRequest): void {
    this.touch();
    this.elicitationBroker?.issue(this.id, req);
  }

  private handleUsage(u: UsageStats): void {
    this.cost.add(u);
    this.trackedSave();
  }

  // ---- Synthesis helpers ---------------------------------------------------

  /** Inject a synthetic NotificationEvent (used by BudgetGuard). */
  private injectEvent(event: NotificationEvent): void {
    this.history.push(event);
    this.emitEvent(event);
    const next = transition(this.agentStatus, event);
    if (next !== this.agentStatus) this.setAgentStatus(next);
  }

  private setLegacyStatus(s: SessionStatus): void {
    if (this.legacyStatus === s) return;
    if (this.legacyStatus === 'stopped') return;  // terminal
    this.legacyStatus = s;
  }

  private setAgentStatus(next: AgentStatus): void {
    this.agentStatus = next;
    this.emitStatusChange(next);
  }

  private emitEvent(e: NotificationEvent): void {
    for (const l of this.eventListeners) { try { l(e); } catch { /* isolate */ } }
  }
  private emitStatusChange(s: AgentStatus): void {
    for (const l of this.statusListeners) { try { l(s); } catch { /* isolate */ } }
  }

  private touch(): void { this.lastActivityAt = Date.now(); }

  private async saveSnapshot(): Promise<void> {
    try { await this.persistence.saveSnapshot(this.snapshotLegacy()); }
    catch { /* surface via logger upstream */ }
  }

  /** Fire-and-forget save with in-flight tracking so stop()/flushPendingPersistence
   *  can await durable completion. */
  private trackedSave(): void {
    const p = this.persistence.saveSnapshot(this.snapshotLegacy())
      .catch(() => undefined);
    this.pendingSaves.add(p);
    void p.finally(() => this.pendingSaves.delete(p));
  }

  /** Test helper / external flush: await any in-flight tracked saveSnapshot
   *  calls. Production code should prefer stop() — this exists to support
   *  deterministic teardown in tests where the session is not yet stopping. */
  async flushPendingPersistence(): Promise<void> {
    if (this.pendingSaves.size === 0) return;
    await Promise.all([...this.pendingSaves]);
  }
}

/** Backward-compat alias — bridge and v0 tests import `Session`. */
export { LocalSession as Session };
