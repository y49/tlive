// src/permission/ask-broker.ts
//
// AskUserQuestionBroker — parallel to PermissionBroker but for
// AskUserQuestionRequest (multi-choice questions the agent asks the user).
// Same issue/resolve/denyAll/subscribe shape; no PolicyStore (we don't
// auto-answer questions — that's the agent's job).
//
// Spec: docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md §5.2.

import type { AskUserQuestionRequest } from '../runtime/types.js';

export type AskBrokerEvent =
  | { kind: 'pending'; sessionId: string; request: AskUserQuestionRequest }
  | {
      kind: 'resolved';
      sessionId: string;
      requestId: string;
      chosen: string[];
      resolvedByUserId?: string;
    };

export type AskBrokerListener = (ev: AskBrokerEvent) => void;

export class AskUserQuestionBroker {
  private readonly pending = new Map<string, Map<string, AskUserQuestionRequest>>();
  private readonly listeners = new Set<AskBrokerListener>();

  issue(sessionId: string, req: AskUserQuestionRequest): void {
    const map = this.pending.get(sessionId) ?? new Map<string, AskUserQuestionRequest>();
    if (map.has(req.id)) {
      throw new Error(`AskUserQuestionBroker: duplicate pending id ${req.id}`);
    }
    map.set(req.id, req);
    this.pending.set(sessionId, map);
    this.emit({ kind: 'pending', sessionId, request: req });
  }

  resolve(
    sessionId: string,
    requestId: string,
    chosen: string[],
    resolvedByUserId?: string,
  ): boolean {
    const map = this.pending.get(sessionId);
    const req = map?.get(requestId);
    if (!req || !map) return false;
    map.delete(requestId);
    if (map.size === 0) this.pending.delete(sessionId);
    try { req.resolve(chosen); } catch { /* isolate */ }
    this.emit({ kind: 'resolved', sessionId, requestId, chosen, resolvedByUserId });
    return true;
  }

  resolveById(requestId: string, chosen: string[], userId?: string): boolean {
    for (const [sessionId, map] of this.pending) {
      if (map.has(requestId)) return this.resolve(sessionId, requestId, chosen, userId);
    }
    return false;
  }

  denyAllForSession(sessionId: string, _reason = 'session_stopped'): void {
    const map = this.pending.get(sessionId);
    if (!map) return;
    const ids = [...map.keys()];
    for (const id of ids) this.resolve(sessionId, id, []);
  }

  pendingFor(sessionId: string): AskUserQuestionRequest[] {
    return [...(this.pending.get(sessionId)?.values() ?? [])];
  }

  pendingCount(): number {
    let n = 0;
    for (const m of this.pending.values()) n += m.size;
    return n;
  }

  subscribe(listener: AskBrokerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: AskBrokerEvent): void {
    for (const l of this.listeners) {
      try { l(ev); } catch { /* isolate */ }
    }
  }
}
