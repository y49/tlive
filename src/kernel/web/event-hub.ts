// src/kernel/web/event-hub.ts
//
// Downstream fan-out for /ws/events: the set of connected browser clients plus
// broadcast + broken-client pruning. Vendor-neutral (frames carry only the
// web-internal SessionView). 6a is downstream-only — no inbound handling here.

import type { SessionView } from './session-registry.js';

export interface EventClient {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

export type EventFrame =
  | { type: 'session-upsert'; session: SessionView }
  | { type: 'session-remove'; id: string };

/** Upstream actions a dashboard client sends over /ws/events. Vendor-neutral. */
export type EventAction =
  | { type: 'approve'; requestId: string; approved: boolean }
  | { type: 'reply'; requestId: string; text: string }
  | { type: 'mute'; id: string; muted: boolean };

/** Parse an inbound /ws/events text frame into a validated EventAction, or null. */
export function parseEventAction(raw: string): EventAction | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  const a = v as Record<string, unknown>;
  switch (a.type) {
    case 'approve':
      return typeof a.requestId === 'string' && typeof a.approved === 'boolean'
        ? { type: 'approve', requestId: a.requestId, approved: a.approved } : null;
    case 'reply':
      return typeof a.requestId === 'string' && typeof a.text === 'string'
        ? { type: 'reply', requestId: a.requestId, text: a.text } : null;
    case 'mute':
      return typeof a.id === 'string' && typeof a.muted === 'boolean'
        ? { type: 'mute', id: a.id, muted: a.muted } : null;
    default:
      return null;
  }
}

export class EventHub {
  private clients = new Set<EventClient>();

  add(c: EventClient): void {
    this.clients.add(c);
  }
  remove(c: EventClient): void {
    this.clients.delete(c);
  }
  size(): number {
    return this.clients.size;
  }

  broadcast(frame: EventFrame): void {
    const data = JSON.stringify(frame);
    for (const c of [...this.clients]) {
      if (c.readyState !== c.OPEN) { this.clients.delete(c); continue; }
      try {
        c.send(data);
      } catch {
        this.clients.delete(c);
        try { c.close(); } catch { /* ignore */ }
      }
    }
  }
}
