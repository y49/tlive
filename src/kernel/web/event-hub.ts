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
