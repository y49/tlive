// src/session/manager.ts
//
// v1.0 unified SessionManager (spec §4.4). Orchestrates LocalSession +
// RemoteSession under a single indexable map keyed by sdkSessionId, with
// short-alias prefix lookup for IM/CLI `/s <prefix>` commands.
//
// Backward-compatibility: keeps the v0.x `create` / `resume` / `list` /
// `hydrateFromDisk` API for the bridge layer until T8 deletes it. New call
// sites should prefer `createLocal` / `resumeLocal` / `registerRemote` /
// `getByPrefix`. `subscribe(ManagerEventListener)` is canonical post-T2.

import { randomUUID } from 'node:crypto';
import type { AgentProvider, AgentRuntime, PermissionMode } from '../runtime/types.js';
import { SessionContext } from './context.js';
import { LocalSession } from './local-session.js';
import { RemoteSession, type RemoteSessionInit } from './remote-session.js';
import type { SessionLike, SessionInfo } from './types.js';
import type { SessionPersistence, SessionSnapshot } from './persistence.js';
import type { PermissionBroker } from '../permission/broker.js';
import type { AskUserQuestionBroker } from '../permission/ask-broker.js';
import type { ElicitationBroker } from '../permission/elicitation-broker.js';
import type { AttachmentStore } from '../attachment/store.js';
import { resolveByPrefix } from '../util/short-id.js';
import { WarmRuntimePool } from './warm-pool.js';
import type { CostRollupStore } from '../cost/rollups.js';

// ---- Options -------------------------------------------------------------

export interface CreateLocalSessionOptions {
  workspaceId: string;
  workspaceName?: string;
  provider: AgentProvider;
  workdir: string;
  initialPrompt?: string;
  permissionMode?: PermissionMode;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  maxBudgetUsd?: number;
  source: 'cli' | 'im';
}

/** Back-compat alias — existing bridge IPC handler uses this name. */
export type CreateSessionOptions = CreateLocalSessionOptions;

export interface RegisterRemoteSessionOptions extends RemoteSessionInit {}

export type RuntimeFactory = (provider: AgentProvider) => AgentRuntime;

export type ManagerEventListener = (ev:
  | { kind: 'created'; session: LocalSession }
  | { kind: 'resumed'; session: LocalSession }
  | { kind: 'registered'; session: RemoteSession }
  | { kind: 'stopped'; sessionId: string }
) => void;

export interface SessionManagerDeps {
  persistence: SessionPersistence;
  broker: PermissionBroker;
  /** Optional AskUserQuestion broker. When absent, LocalSession drops ask
   *  requests (the runtime's promise still settles via interrupt/stop). */
  askBroker?: AskUserQuestionBroker;
  /** Optional Elicitation broker. Same semantics as askBroker. */
  elicitationBroker?: ElicitationBroker;
  /** Optional shared AttachmentStore. Wired by T9 daemon bootstrap; T4 just
   *  plumbs the type so downstream consumers can fetch inbound files. */
  attachmentStore?: AttachmentStore;
  runtimeFactory: RuntimeFactory;
  /**
   * Optional warm pool. T3 scope keeps this as scaffolding only — stop()
   * never parks, so pluck() always returns null. Re-enabled once
   * AgentRuntime.reset() lands (T9+).
   */
  warmPool?: WarmRuntimePool;
  /** Optional rollup store. LocalSessions will append per-turn cost deltas here. */
  rollupStore?: CostRollupStore;
}

// ---- Manager -------------------------------------------------------------

export class SessionManager {
  private sessions = new Map<string, SessionLike>();
  private listeners = new Set<ManagerEventListener>();
  private readonly warmPool: WarmRuntimePool | null;
  private readonly rollupStore: CostRollupStore | null;

  constructor(private readonly deps: SessionManagerDeps) {
    this.warmPool = deps.warmPool ?? null;
    this.rollupStore = deps.rollupStore ?? null;
  }

  // ---- New v1.0 API --------------------------------------------------------

  async createLocal(opts: CreateLocalSessionOptions): Promise<LocalSession> {
    const id = randomUUID();
    const ctx = SessionContext.create({
      sessionId: id,
      workdir: opts.workdir,
      workspaceId: opts.workspaceId,
      workspaceName: opts.workspaceName,
      provider: opts.provider,
    });
    const runtime = this.pluckOrBuildRuntime(opts.provider, opts.workspaceId);
    const session = new LocalSession({
      ctx,
      runtime,
      persistence: this.deps.persistence,
      broker: this.deps.broker,
      askBroker: this.deps.askBroker,
      elicitationBroker: this.deps.elicitationBroker,
      maxBudgetUsd: opts.maxBudgetUsd,
      rollupStore: this.rollupStore ?? undefined,
    });
    await session.prepare({
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
      initialPrompt: opts.initialPrompt,
    });
    this.sessions.set(id, session);
    this.emit({ kind: 'created', session });
    session.attachSink();
    return session;
  }

  async resumeLocal(id: string): Promise<LocalSession | null> {
    const existing = this.sessions.get(id);
    if (existing && existing.kind === 'local') return existing as LocalSession;
    const snap = await this.deps.persistence.loadSnapshot(id);
    if (!snap) return null;
    const ctx = new SessionContext(snap.ctx);
    const runtime = this.pluckOrBuildRuntime(snap.ctx.provider, snap.ctx.workspaceId);
    const session = new LocalSession({
      ctx,
      runtime,
      persistence: this.deps.persistence,
      broker: this.deps.broker,
      askBroker: this.deps.askBroker,
      elicitationBroker: this.deps.elicitationBroker,
      rollupStore: this.rollupStore ?? undefined,
    });
    await session.prepare({});
    this.sessions.set(id, session);
    this.emit({ kind: 'resumed', session });
    session.attachSink();
    return session;
  }

  registerRemote(opts: RegisterRemoteSessionOptions): RemoteSession {
    if (this.sessions.has(opts.sdkSessionId)) {
      const existing = this.sessions.get(opts.sdkSessionId)!;
      if (existing.kind === 'remote') return existing as RemoteSession;
      throw new Error(`registerRemote: id ${opts.sdkSessionId} already taken by a local session`);
    }
    const session = new RemoteSession(opts);
    this.sessions.set(opts.sdkSessionId, session);
    this.emit({ kind: 'registered', session });
    return session;
  }

  /**
   * Return type is the concrete LocalSession | RemoteSession union (not the
   * narrower SessionLike) so callers can access legacy LocalSession methods
   * like `.sendInput` + `.context` without casting. T8 tightens this to
   * SessionLike once bridge is gone.
   */
  get(id: string): LocalSession | RemoteSession | undefined {
    return this.sessions.get(id) as LocalSession | RemoteSession | undefined;
  }

  /** Resolve a user-typed short alias (≥4 hex) against live sessions. */
  getByPrefix(prefix: string): { resolved: SessionLike | null; ambiguous: SessionLike[] } {
    return resolveByPrefix([...this.sessions.values()], prefix, (s) => s.id);
  }

  listInfo(kind?: 'local' | 'remote'): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => !kind || s.kind === kind)
      .map((s) => s.snapshot());
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stop(id).catch(() => { /* isolate */ })));
    // Pool is always empty in T3 (stop never parks), but drain anyway in case
    // a future task re-enables pooling and forgets to update shutdown.
    if (this.warmPool) await this.warmPool.drain();
  }

  async stop(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.kind === 'local') {
      const local = s as LocalSession;
      // Warm-pool reuse is deferred: both ClaudeSdkRuntime and
      // CodexAppServerRuntime throw on a second start(), so parking a
      // runtime for reuse would crash the next createLocal. Always fully
      // stop. When AgentRuntime.reset() lands (T9+), this branch can
      // reintroduce the detach+park path.
      await local.stop();
    } else {
      (s as RemoteSession).onDisconnect('manager_stop');
    }
    this.sessions.delete(id);
    this.emit({ kind: 'stopped', sessionId: id });
  }

  subscribe(listener: ManagerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- Legacy v0.x API (bridge + old tests) --------------------------------

  /** Alias for createLocal; throws on remote-only deployments. */
  async create(opts: CreateLocalSessionOptions): Promise<LocalSession> {
    return this.createLocal(opts);
  }

  /** Alias for resumeLocal. Returns null for unknown ids (preserves v0 semantics). */
  async resume(id: string): Promise<LocalSession | null> {
    return this.resumeLocal(id);
  }

  /** Legacy list → SessionSnapshot[] for IPC compatibility. */
  list(): SessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((s): s is LocalSession => s.kind === 'local')
      .map((s) => s.snapshotLegacy());
  }

  /** Hydrate persisted snapshots from disk without starting runtimes. */
  async hydrateFromDisk(): Promise<SessionSnapshot[]> {
    return this.deps.persistence.listSnapshots();
  }

  // ---- Internal ------------------------------------------------------------

  private pluckOrBuildRuntime(provider: AgentProvider, workspaceId: string): AgentRuntime {
    // T3 scope: warm-pool infrastructure is wired but reuse is deferred until
    // AgentRuntime.reset() exists (real runtimes reject a second start()).
    // stop() never parks, so pluck() is always null in production — the
    // factory path is always taken. Kept as a placeholder so a future task
    // can re-enable pooling by restoring the detach+park path in stop().
    if (this.warmPool) {
      const warm = this.warmPool.pluck(provider, workspaceId);
      if (warm) return warm;
    }
    return this.deps.runtimeFactory(provider);
  }

  private emit(ev: Parameters<ManagerEventListener>[0]): void {
    for (const l of this.listeners) { try { l(ev); } catch { /* isolate */ } }
  }
}
