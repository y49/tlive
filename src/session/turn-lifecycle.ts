// src/session/turn-lifecycle.ts
//
// Minimal observer that tracks turn boundaries by consuming NotificationEvent
// frames emitted by the runtime adapters. Used by LocalSession + CLI/TUI to
// know "are we in the middle of a turn right now?" without having to scan all
// events. T3 wires this into the full AgentStatus state machine via
// src/session/status.ts's `transition()` function; T2 only provides the type
// stub there.

import type { NotificationEvent } from '../runtime/events.js';

export interface TurnLifecycleObserver {
  /** Feed an event; returns any synthesized events (currently none). */
  onEvent(e: NotificationEvent): NotificationEvent[];
}

export class TurnLifecycle implements TurnLifecycleObserver {
  private turnId: string | null = null;
  private turnStartedAt = 0;

  onEvent(e: NotificationEvent): NotificationEvent[] {
    switch (e.kind) {
      case 'turn_start':
        this.turnId = e.turnId;
        this.turnStartedAt = e.at;
        return [];
      case 'turn_end':
        this.turnId = null;
        this.turnStartedAt = 0;
        return [];
      default:
        return [];
    }
  }

  currentTurnId(): string | null { return this.turnId; }

  durationMs(): number {
    return this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
  }
}
