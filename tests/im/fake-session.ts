// tests/im/fake-session.ts
//
// Minimal SessionLike + fake SessionManager used to drive SessionFrontend
// tests without booting a real runtime. Does the barest wiring the frontend
// needs: subscribe(listener) for create/resume/stop, and per-session
// onEvent(cb) for NotificationEvent emission.

import type { SessionLike, SessionEventKind, SessionInfo } from '../../src/session/types.js';
import type { NotificationEvent } from '../../src/runtime/events.js';
import type { AgentStatus } from '../../src/session/status.js';
import type { SessionManager, ManagerEventListener } from '../../src/session/manager.js';
import { SessionContext } from '../../src/session/context.js';
import { CostTracker } from '../../src/cost/tracker.js';

export class FakeSession implements SessionLike {
  readonly kind = 'local' as const;
  readonly id: string;
  readonly shortAlias: string;
  readonly provider = 'claude' as const;
  readonly workspaceId: string;
  readonly workdir: string;
  readonly ctx: SessionContext;
  title: string | undefined;
  status: AgentStatus = { phase: 'idle', queuedInputs: 0 };
  readonly cost = new CostTracker();
  readonly isReady = true;

  private listeners = new Set<(e: NotificationEvent) => void>();
  private statusListeners = new Set<(s: AgentStatus) => void>();

  constructor(opts: { id: string; workspaceId: string; workdir?: string }) {
    this.id = opts.id;
    this.shortAlias = opts.id.slice(0, 4);
    this.workspaceId = opts.workspaceId;
    this.workdir = opts.workdir ?? '/tmp/workdir';
    this.ctx = SessionContext.create({
      sessionId: opts.id, workdir: this.workdir,
      workspaceId: opts.workspaceId, provider: 'claude',
    });
  }

  onEvent(cb: (e: NotificationEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStatusChange(cb: (s: AgentStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  onSessionIdReady(cb: (id: string) => void): () => void {
    cb(this.id);
    return () => { /* noop */ };
  }

  snapshot(): SessionInfo {
    return {
      id: this.id, shortAlias: this.shortAlias, kind: 'local',
      provider: 'claude', workspaceId: this.workspaceId, workdir: this.workdir,
      title: this.title, status: this.status,
      cost: {
        totalCost: this.cost.totalCost,
        inputTokens: this.cost.inputTokens,
        outputTokens: this.cost.outputTokens,
        cacheReadTokens: this.cost.cacheReadTokens,
        cacheCreationTokens: this.cost.cacheCreationTokens,
      },
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
  }

  subscribe(listener: (ev: SessionEventKind) => void): () => void {
    const a = this.onEvent((event) => listener({ kind: 'event', event }));
    const b = this.onStatusChange((status) => listener({ kind: 'status_change', status }));
    return () => { a(); b(); };
  }

  emit(ev: NotificationEvent): void {
    for (const l of this.listeners) l(ev);
  }
}

// ---------------------------------------------------------------------------
// Canonical fake SessionManager
// ---------------------------------------------------------------------------

export type FakeSessionManager = SessionManager & { push: ManagerEventListener };

/** Canonical fake SessionManager used by IM frontend / multi-binding / smoke tests.
 *  Always provides a working `get(id)` method to avoid the silent-throw class of
 *  bugs where SessionFrontend.buildInitialHudState (post-T10) silently fails when
 *  the manager mock returns undefined (or worse, has no `get` method at all).
 *
 *  Pass a `sessions` map to wire up real FakeSession lookups; otherwise `get`
 *  returns undefined which is also valid (frontend code must handle missing
 *  sessions gracefully). */
export function mkFakeSessionManager(
  opts: { sessions?: Map<string, FakeSession> } = {},
): FakeSessionManager {
  const sessions = opts.sessions ?? new Map<string, FakeSession>();
  const listeners = new Set<ManagerEventListener>();
  return {
    subscribe(l: ManagerEventListener) { listeners.add(l); return () => listeners.delete(l); },
    push(ev) { for (const l of listeners) l(ev); },
    get(id: string) { return sessions.get(id); },
  } as unknown as FakeSessionManager;
}
