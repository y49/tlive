// src/permission/broker.ts
//
// v1.0 categorized PermissionBroker — replaces the T1-era single-category
// `src/session/permission-broker.ts` shim. Receives 4-category-tagged
// PermissionRequests from the AgentRuntime, auto-resolves against the
// workspace-scoped PolicyStore before broadcasting, and surfaces
// issue/resolve/denyAll semantics to IM / MCP frontends.
//
// Spec: docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md §5.1.
// Design note: the runtime (Claude / Codex) owns the actual PermissionResult
// callback; the broker just holds the request in memory so multiple IM users
// can see + resolve it, and routes resolution back to the runtime via
// req.resolve(decision). req.id carries `${sdkSessionId}:${shortId}` form.

import type { PermissionRequest, PermissionDecision } from '../runtime/types.js';
import type { PolicyStore, PolicyRule } from './policy-store.js';

export type BrokerEvent =
  | { kind: 'pending'; sessionId: string; request: PermissionRequest }
  | {
      kind: 'resolved';
      sessionId: string;
      requestId: string;
      decision: PermissionDecision;
      /** Optional operator id for audit logging — T7 CommandRouter supplies this. */
      resolvedByUserId?: string;
      /** True when resolved automatically by a PolicyStore rule match. */
      autoResolvedBy?: PolicyRule['id'];
    };

export type BrokerListener = (ev: BrokerEvent) => void;

/**
 * Per-workspace policy lookup. Manager-level deps pass a factory so each
 * session resolves against its own workspace's policies.
 */
export type PolicyStoreResolver = (workspaceId: string) => PolicyStore | undefined;

export interface PermissionBrokerOptions {
  /**
   * Optional resolver for per-workspace PolicyStore. When present, issue()
   * matches each request against the store first and auto-resolves on hit
   * (without emitting 'pending' to listeners). T9 wires this in; unit tests
   * can pass a direct function.
   */
  policyStoreFor?: PolicyStoreResolver;
}

/**
 * Category-aware PermissionBroker.
 *
 * Lifecycle:
 * - `issue(sessionId, workspaceId, req)` — runtime produced a request; broker
 *   tries PolicyStore auto-resolve, else stores and emits 'pending'.
 * - `resolve(sessionId, requestId, decision, userId?)` — frontend resolved
 *   via IM button / MCP tool / CLI command. Broker invokes req.resolve and
 *   emits 'resolved'.
 * - `denyAllForSession(sessionId, reason)` — session shutdown or /interrupt.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, Map<string, PermissionRequest>>();
  private readonly listeners = new Set<BrokerListener>();
  private readonly options: PermissionBrokerOptions;

  constructor(options: PermissionBrokerOptions = {}) {
    this.options = options;
  }

  /**
   * Record a pending permission and emit `pending` to listeners, UNLESS a
   * PolicyStore rule matches — in which case auto-resolve silently.
   *
   * `workspaceId` routes PolicyStore lookup; pass `undefined` / empty string
   * to skip auto-resolve (tests do this).
   */
  issue(sessionId: string, workspaceId: string | undefined, req: PermissionRequest): void {
    // Guard: duplicate id on the same session is a programmer error. Surface
    // loudly so runtime/session wiring bugs don't silently drop requests.
    const sessionMap = this.pending.get(sessionId) ?? new Map<string, PermissionRequest>();
    if (sessionMap.has(req.id)) {
      throw new Error(`PermissionBroker: duplicate pending id ${req.id}`);
    }

    // Policy auto-resolve. On hit, don't store the request and don't emit
    // 'pending' — just chain through the runtime resolver and emit 'resolved'.
    const autoRule = this.lookupPolicy(workspaceId, req);
    if (autoRule) {
      try { req.resolve(autoRule.decision); } catch { /* runtime callback isolate */ }
      this.emit({
        kind: 'resolved',
        sessionId,
        requestId: req.id,
        decision: autoRule.decision,
        autoResolvedBy: autoRule.id,
      });
      return;
    }

    sessionMap.set(req.id, req);
    this.pending.set(sessionId, sessionMap);
    this.emit({ kind: 'pending', sessionId, request: req });
  }

  /**
   * Resolve a pending request by (sessionId, requestId). Returns false if
   * the request is unknown (already resolved, wrong session, etc.).
   */
  resolve(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
    resolvedByUserId?: string,
  ): boolean {
    const map = this.pending.get(sessionId);
    const req = map?.get(requestId);
    if (!req || !map) return false;
    map.delete(requestId);
    if (map.size === 0) this.pending.delete(sessionId);
    try { req.resolve(decision); } catch { /* runtime callback isolate */ }
    this.emit({ kind: 'resolved', sessionId, requestId, decision, resolvedByUserId });
    return true;
  }

  /**
   * Resolve-by-id without knowing the session. Scans pending sessions and
   * finds the owning one. Intended for back-compat with legacy callers
   * (bridge callback-router + IPC handler) that only carry the compound id
   * `${sdkSessionId}:${shortId}`. T8 deletes bridge; then this helper can go.
   */
  resolveById(requestId: string, decision: PermissionDecision, userId?: string): boolean {
    for (const [sessionId, map] of this.pending) {
      if (map.has(requestId)) return this.resolve(sessionId, requestId, decision, userId);
    }
    return false;
  }

  /**
   * Deny every pending request for a session (session stop / interrupt).
   * Reason is unused today but reserved for audit-log wiring (T7).
   */
  denyAllForSession(sessionId: string, _reason = 'session_stopped'): void {
    const map = this.pending.get(sessionId);
    if (!map) return;
    // Snapshot ids before mutating so resolve()'s own delete doesn't race.
    const ids = [...map.keys()];
    for (const id of ids) this.resolve(sessionId, id, 'deny');
  }

  /**
   * Deny every pending request across all sessions (daemon shutdown). Used
   * by bridge/main.ts at SIGTERM. Removed when bridge goes away in T8.
   */
  denyAll(): void {
    for (const sessionId of [...this.pending.keys()]) {
      this.denyAllForSession(sessionId, 'daemon_shutdown');
    }
  }

  /** Snapshot of pending requests for a given session. Order: insertion. */
  pendingFor(sessionId: string): PermissionRequest[] {
    return [...(this.pending.get(sessionId)?.values() ?? [])];
  }

  /** Total pending count across all sessions. Used by health / metrics. */
  pendingCount(): number {
    let n = 0;
    for (const m of this.pending.values()) n += m.size;
    return n;
  }

  subscribe(listener: BrokerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- Internal -----------------------------------------------------------

  private lookupPolicy(workspaceId: string | undefined, req: PermissionRequest): PolicyRule | null {
    if (!workspaceId) return null;
    const store = this.options.policyStoreFor?.(workspaceId);
    if (!store) return null;
    try {
      return store.match(req);
    } catch {
      // PolicyStore.match is pure but defensive — a bad rule shouldn't block
      // the user. Fall through to manual-approval path.
      return null;
    }
  }

  private emit(ev: BrokerEvent): void {
    for (const l of this.listeners) {
      try { l(ev); } catch { /* listener errors isolate */ }
    }
  }
}
