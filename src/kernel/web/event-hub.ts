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

/** Upstream actions a dashboard client sends over /ws/events. Vendor-neutral.
 *  `ask` answers an AskUserQuestion card (#50) on the same wire as the IM
 *  buttons: picks are option indexes into pending.ask.options, optional free
 *  text is appended to the selection, skip = allow pass-through (leave the
 *  question to the terminal — never an auto-answer), back = step to the
 *  previous question of a multi-question batch. */
export type EventAction =
  | { type: 'approve'; requestId: string; approved: boolean; alwaysAllowTool?: string }
  | { type: 'ask'; requestId: string; picks: number[]; text?: string; skip?: boolean; back?: boolean }
  | { type: 'reply'; requestId: string; text: string }
  | { type: 'mute'; id: string; muted: boolean }
  | { type: 'inject'; id: string; text: string };

/** Parse an inbound /ws/events text frame into a validated EventAction, or null. */
export function parseEventAction(raw: string): EventAction | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  const a = v as Record<string, unknown>;
  switch (a.type) {
    case 'approve':
      return typeof a.requestId === 'string' && typeof a.approved === 'boolean'
        ? {
            type: 'approve', requestId: a.requestId, approved: a.approved,
            ...(typeof a.alwaysAllowTool === 'string' && a.alwaysAllowTool ? { alwaysAllowTool: a.alwaysAllowTool } : {}),
          } : null;
    case 'ask': {
      if (typeof a.requestId !== 'string') return null;
      if (!Array.isArray(a.picks) || !a.picks.every((p) => typeof p === 'number' && Number.isInteger(p) && p >= 0)) return null;
      return {
        type: 'ask', requestId: a.requestId, picks: a.picks as number[],
        ...(typeof a.text === 'string' && a.text.trim() ? { text: a.text } : {}),
        ...(a.skip === true ? { skip: true } : {}),
        ...(a.back === true ? { back: true } : {}),
      };
    }
    case 'reply':
      return typeof a.requestId === 'string' && typeof a.text === 'string'
        ? { type: 'reply', requestId: a.requestId, text: a.text } : null;
    case 'mute':
      return typeof a.id === 'string' && typeof a.muted === 'boolean'
        ? { type: 'mute', id: a.id, muted: a.muted } : null;
    case 'inject':
      return typeof a.id === 'string' && typeof a.text === 'string' && a.text.length > 0
        ? { type: 'inject', id: a.id, text: a.text } : null;
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
