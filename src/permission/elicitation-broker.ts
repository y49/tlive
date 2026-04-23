// src/permission/elicitation-broker.ts
//
// ElicitationBroker — parallel to PermissionBroker but for MCP-originated
// `ElicitationRequest` (form inputs, URL auth flows, confirm dialogs).
// Resolution carries a `{ action, content? }` payload that the MCP server
// consumes as the elicitation result.
//
// Spec: docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md §5.3.

import type { ElicitationRequest } from '../runtime/types.js';

export type ElicitationResult = Parameters<ElicitationRequest['resolve']>[0];

export type ElicitationBrokerEvent =
  | { kind: 'pending'; sessionId: string; request: ElicitationRequest }
  | {
      kind: 'resolved';
      sessionId: string;
      requestId: string;
      result: ElicitationResult;
      resolvedByUserId?: string;
    };

export type ElicitationBrokerListener = (ev: ElicitationBrokerEvent) => void;

export class ElicitationBroker {
  private readonly pending = new Map<string, Map<string, ElicitationRequest>>();
  private readonly listeners = new Set<ElicitationBrokerListener>();

  issue(sessionId: string, req: ElicitationRequest): void {
    const map = this.pending.get(sessionId) ?? new Map<string, ElicitationRequest>();
    if (map.has(req.id)) {
      throw new Error(`ElicitationBroker: duplicate pending id ${req.id}`);
    }
    map.set(req.id, req);
    this.pending.set(sessionId, map);
    this.emit({ kind: 'pending', sessionId, request: req });
  }

  resolve(
    sessionId: string,
    requestId: string,
    result: ElicitationResult,
    resolvedByUserId?: string,
  ): boolean {
    const map = this.pending.get(sessionId);
    const req = map?.get(requestId);
    if (!req || !map) return false;
    map.delete(requestId);
    if (map.size === 0) this.pending.delete(sessionId);
    try { req.resolve(result); } catch { /* isolate */ }
    this.emit({ kind: 'resolved', sessionId, requestId, result, resolvedByUserId });
    return true;
  }

  resolveById(requestId: string, result: ElicitationResult, userId?: string): boolean {
    for (const [sessionId, map] of this.pending) {
      if (map.has(requestId)) return this.resolve(sessionId, requestId, result, userId);
    }
    return false;
  }

  denyAllForSession(sessionId: string, _reason = 'session_stopped'): void {
    const map = this.pending.get(sessionId);
    if (!map) return;
    const ids = [...map.keys()];
    for (const id of ids) this.resolve(sessionId, id, { action: 'decline' });
  }

  pendingFor(sessionId: string): ElicitationRequest[] {
    return [...(this.pending.get(sessionId)?.values() ?? [])];
  }

  pendingCount(): number {
    let n = 0;
    for (const m of this.pending.values()) n += m.size;
    return n;
  }

  subscribe(listener: ElicitationBrokerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: ElicitationBrokerEvent): void {
    for (const l of this.listeners) {
      try { l(ev); } catch { /* isolate */ }
    }
  }
}
