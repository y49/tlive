// src/session/session.ts
//
// Per-session state: runtime ownership, event history, pending permissions,
// cost accumulator, status transitions. Fans events out to listeners and
// persists every event via SessionPersistence.

import type { AgentRuntime, AgentRuntimeOptions, PermissionRequest } from '../runtime/types.js';
import type { NotificationEvent, UsageStats } from '../runtime/events.js';
import { SessionContext, type SessionContextSnapshot } from './context.js';
import type { SessionPersistence, SessionSnapshot } from './persistence.js';
import type { PermissionBroker } from './permission-broker.js';
import { CostTracker } from './cost-tracker.js';

export type SessionStatus = 'starting' | 'active' | 'idle' | 'stopped';

export type SessionEventListener = (ev:
  | { kind: 'event'; event: NotificationEvent }
  | { kind: 'status'; status: SessionStatus }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'usage'; usage: UsageStats }
) => void;

export interface SessionInit {
  ctx: SessionContext;
  runtime: AgentRuntime;
  persistence: SessionPersistence;
  broker: PermissionBroker;
}

export class Session {
  readonly id: string;
  private readonly ctx: SessionContext;
  private readonly runtime: AgentRuntime;
  private readonly persistence: SessionPersistence;
  private readonly broker: PermissionBroker;
  private readonly cost = new CostTracker();
  private readonly listeners = new Set<SessionEventListener>();
  private readonly unsubscribers: Array<() => void> = [];

  private history: NotificationEvent[] = [];
  private status: SessionStatus = 'starting';
  private createdAt: number;
  private lastActivityAt: number;
  private abortCtrl = new AbortController();

  constructor(init: SessionInit) {
    this.ctx = init.ctx;
    this.runtime = init.runtime;
    this.persistence = init.persistence;
    this.broker = init.broker;
    this.id = init.ctx.snapshot.sessionId;
    this.createdAt = init.ctx.snapshot.createdAt;
    this.lastActivityAt = this.createdAt;
  }

  get context(): SessionContextSnapshot { return this.ctx.snapshot; }
  get provider() { return this.ctx.snapshot.provider; }
  getHistory(): readonly NotificationEvent[] { return this.history; }
  getStatus(): SessionStatus { return this.status; }

  async start(opts: Omit<AgentRuntimeOptions, 'workdir' | 'signal'>): Promise<void> {
    this.unsubscribers.push(this.runtime.onEvent((e) => this.handleEvent(e)));
    this.unsubscribers.push(this.runtime.onPermissionRequest((req) => this.handlePermission(req)));
    this.unsubscribers.push(this.runtime.onUsage((u) => this.handleUsage(u)));
    await this.runtime.start({
      ...opts,
      workdir: this.ctx.snapshot.workdir,
      signal: this.abortCtrl.signal,
    });
    this.setStatus('active');
    await this.saveSnapshot();
  }

  async sendInput(text: string, _source: 'im' | 'cli'): Promise<void> {
    if (this.status === 'stopped') throw new Error('Session stopped');
    this.touch();
    await this.runtime.sendInput(text);
  }

  /** Frontend (IM/CLI) calls this. Returns false if id unknown. */
  resolvePermission(id: string, decision: 'allow' | 'deny' | 'allow_always'): boolean {
    return this.broker.resolve(id, decision);
  }

  listPendingPermissions(): PermissionRequest[] {
    return this.broker.listForSession(this.id);
  }

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      ctx: this.ctx.snapshot,
      status: this.status,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      cost: this.cost.snapshot(),
      pendingPermissionIds: this.listPendingPermissions().map((r) => r.id),
    };
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') return;
    this.abortCtrl.abort();
    for (const un of this.unsubscribers) un();
    this.unsubscribers.length = 0;
    this.broker.denyAllForSession(this.id);
    try { await this.runtime.stop(); } catch { /* already stopping */ }
    this.setStatus('stopped');
    await this.saveSnapshot();
  }

  // ---- private ------------------------------------------------------------

  private handleEvent(event: NotificationEvent): void {
    this.touch();
    this.history.push(event);
    // Fire-and-forget persistence — history is append-only, ordering preserved by node fs.
    void this.persistence.appendEvent(this.id, event).catch(() => { /* surface via logger upstream */ });
    this.emit({ kind: 'event', event });
    if (event.kind === 'session_complete') {
      this.setStatus('idle');
      void this.saveSnapshot();
    } else if (event.kind === 'runtime_error') {
      this.setStatus('idle');
      void this.saveSnapshot();
    }
  }

  private handlePermission(req: PermissionRequest): void {
    this.touch();
    // Runtime emits id in `${sessionId}:${toolUseId}` format; split once and
    // let the broker re-key so there is exactly one source of truth for ids.
    const toolUseId = req.id.includes(':') ? req.id.slice(req.id.indexOf(':') + 1) : req.id;
    const { request } = this.broker.waitFor(
      this.id, toolUseId, req.toolName, req.toolInput as Record<string, unknown>, req.resolve,
    );
    this.emit({ kind: 'permission', request });
  }

  private handleUsage(u: UsageStats): void {
    this.cost.add(u);
    this.emit({ kind: 'usage', usage: u });
    void this.saveSnapshot();
  }

  private setStatus(s: SessionStatus): void {
    if (this.status === s) return;
    // 'stopped' is terminal — guard against late events from real SDK runtimes
    // flipping status back to 'idle' after teardown has committed.
    if (this.status === 'stopped') return;
    this.status = s;
    this.emit({ kind: 'status', status: s });
  }

  private emit(ev: Parameters<SessionEventListener>[0]): void {
    for (const l of this.listeners) { try { l(ev); } catch { /* isolate */ } }
  }

  private touch(): void { this.lastActivityAt = Date.now(); }

  private async saveSnapshot(): Promise<void> {
    try { await this.persistence.saveSnapshot(this.snapshot()); }
    catch { /* surface via logger upstream */ }
  }
}
