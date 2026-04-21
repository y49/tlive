// src/session/permission-broker.ts

import type { PermissionDecision, PermissionRequest } from '../runtime/types.js';

type Entry = {
  request: PermissionRequest;
  /** Resolver for the waitFor promise — distinct from request.resolve,
   *  which the SDK holds. Both fire on resolve(). */
  promiseResolve: (decision: PermissionDecision) => void;
  sessionId: string;
};

export type PermissionBrokerListener = (ev:
  | { kind: 'pending'; request: PermissionRequest; sessionId: string }
  | { kind: 'resolved'; id: string; decision: PermissionDecision; sessionId: string }
) => void;

export class PermissionBroker {
  private entries = new Map<string, Entry>();  // key = request.id
  private listeners = new Set<PermissionBrokerListener>();

  /**
   * Register a pending permission. Called by Session.handlePermission.
   * Returns the broker-managed PermissionRequest (so Session can emit it to
   * listeners) and a completion promise that resolves when a frontend
   * (IM/CLI) calls resolve(). Both are wired to also invoke runtimeResolve
   * so the SDK/transport sees the decision.
   */
  waitFor(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    runtimeResolve: (decision: PermissionDecision) => void,
  ): { request: PermissionRequest; completion: Promise<PermissionDecision> } {
    const id = `${sessionId}:${toolUseId}`;
    if (this.entries.has(id)) {
      throw new Error(`PermissionBroker: duplicate pending id ${id}`);
    }
    let promiseResolve!: (d: PermissionDecision) => void;
    const completion = new Promise<PermissionDecision>((r) => { promiseResolve = r; });
    const chained = (d: PermissionDecision) => { runtimeResolve(d); promiseResolve(d); };
    const request: PermissionRequest = {
      id, toolName, toolInput,
      resolve: (decision) => this.resolve(id, decision),
    };
    this.entries.set(id, { request, promiseResolve: chained, sessionId });
    this.emit({ kind: 'pending', request, sessionId });
    return { request, completion };
  }

  resolve(id: string, decision: PermissionDecision): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    entry.promiseResolve(decision);
    this.emit({ kind: 'resolved', id, decision, sessionId: entry.sessionId });
    return true;
  }

  listForSession(sessionId: string): PermissionRequest[] {
    return [...this.entries.values()]
      .filter((e) => e.sessionId === sessionId)
      .map((e) => e.request);
  }

  denyAllForSession(sessionId: string): void {
    // Snapshot ids first — iteration is safe under mutation but snapshot keeps
    // denyAll / denyAllForSession symmetrical and clearer to a later reader.
    const ids = [...this.entries.entries()]
      .filter(([, entry]) => entry.sessionId === sessionId)
      .map(([id]) => id);
    for (const id of ids) this.resolve(id, 'deny');
  }

  denyAll(): void {
    for (const id of [...this.entries.keys()]) this.resolve(id, 'deny');
  }

  pendingCount(): number { return this.entries.size; }

  subscribe(listener: PermissionBrokerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: Parameters<PermissionBrokerListener>[0]): void {
    for (const l of this.listeners) {
      try { l(ev); } catch { /* listener errors isolated */ }
    }
  }
}
