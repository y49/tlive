// src/session/manager.ts

import { randomUUID } from 'node:crypto';
import type { AgentProvider, AgentRuntime, PermissionMode } from '../runtime/types.js';
import { SessionContext } from './context.js';
import { Session, type SessionEventListener } from './session.js';
import type { SessionPersistence, SessionSnapshot } from './persistence.js';
import type { PermissionBroker } from './permission-broker.js';

export interface CreateSessionOptions {
  workspaceId: string;
  workspaceName?: string;
  provider: AgentProvider;
  workdir: string;
  initialPrompt?: string;
  permissionMode?: PermissionMode;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  source: 'cli' | 'im';
}

export type RuntimeFactory = (provider: AgentProvider) => AgentRuntime;

export type ManagerEventListener = (ev:
  | { kind: 'created'; session: Session }
  | { kind: 'stopped'; sessionId: string }
  | { kind: 'resumed'; session: Session }
) => void;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private listeners = new Set<ManagerEventListener>();

  constructor(private readonly deps: {
    persistence: SessionPersistence;
    broker: PermissionBroker;
    runtimeFactory: RuntimeFactory;
  }) {}

  async create(opts: CreateSessionOptions): Promise<Session> {
    const id = randomUUID();
    const ctx = SessionContext.create({
      sessionId: id,
      workdir: opts.workdir,
      workspaceId: opts.workspaceId,
      workspaceName: opts.workspaceName,
      provider: opts.provider,
    });
    const runtime = this.deps.runtimeFactory(opts.provider);
    const session = new Session({ ctx, runtime, persistence: this.deps.persistence, broker: this.deps.broker });
    this.sessions.set(id, session);
    await session.start({
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
      initialPrompt: opts.initialPrompt,
    });
    this.emit({ kind: 'created', session });
    return session;
  }

  get(id: string): Session | undefined { return this.sessions.get(id); }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map((s) => s.snapshot());
  }

  async stop(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.stop();
    this.sessions.delete(id);
    this.emit({ kind: 'stopped', sessionId: id });
  }

  /**
   * Stop every live session in parallel. Used by the daemon's SIGTERM/SIGINT
   * shutdown path so runtimes get a chance to drain and persist idle-state
   * snapshots before the process exits. Individual stop() failures are swallowed
   * so one misbehaving session can't block the rest.
   */
  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stop(id).catch(() => { /* isolate */ })));
  }

  /**
   * Load persisted snapshots from disk at daemon startup. Does NOT restart runtimes.
   * User must explicitly resume.
   */
  async hydrateFromDisk(): Promise<SessionSnapshot[]> {
    return this.deps.persistence.listSnapshots();
  }

  /**
   * Resume a previously-persisted session by creating a fresh runtime and
   * passing the old sessionId so the SDK picks up its cached thread.
   */
  async resume(id: string): Promise<Session | null> {
    if (this.sessions.has(id)) return this.sessions.get(id) ?? null;
    const snap = await this.deps.persistence.loadSnapshot(id);
    if (!snap) return null;
    const ctx = new SessionContext(snap.ctx);
    const runtime = this.deps.runtimeFactory(snap.ctx.provider);
    const session = new Session({ ctx, runtime, persistence: this.deps.persistence, broker: this.deps.broker });
    this.sessions.set(id, session);
    await session.start({ /* no initialPrompt on resume */ });
    this.emit({ kind: 'resumed', session });
    return session;
  }

  subscribe(listener: ManagerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Convenience: forward a session's events to a listener. */
  subscribeToSession(id: string, listener: SessionEventListener): (() => void) | null {
    const s = this.sessions.get(id);
    return s ? s.subscribe(listener) : null;
  }

  private emit(ev: Parameters<ManagerEventListener>[0]): void {
    for (const l of this.listeners) { try { l(ev); } catch { /* isolate */ } }
  }
}
