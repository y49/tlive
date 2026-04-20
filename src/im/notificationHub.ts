import { EventEmitter } from 'node:events';
import { type NotificationKind, shouldPush, shouldAggregate } from './notificationRules.js';
import type { NotificationEvent as BridgeNotificationEvent } from '../sdk/sharedEvents.js';
import type { ScannerContextSnapshot } from '../core/scannerContext.js';

export interface NotificationEvent {
  kind: NotificationKind;
  dedupeKey: string;
  sessionId: string;
  title: string;
  body?: string;
  buttons?: Array<{ label: string; callbackData: string; style?: 'primary' | 'danger' }>;
  /** Structured semantic payload for bridge-side rendering. */
  event?: BridgeNotificationEvent;
  /** Session context for the bridge-side TerminalContextDecorator. */
  sessionCtx?: ScannerContextSnapshot;
}

export interface NotificationHubOptions {
  batchDelay?: number;
  isUserActive?: () => boolean;
}

export class NotificationHub extends EventEmitter {
  private seen = new Map<string, number>();
  private batch: NotificationEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchDelay: number;
  private isUserActive?: () => boolean;
  private readonly TTL = 15 * 60 * 1000;

  constructor(opts: NotificationHubOptions = {}) {
    super();
    this.batchDelay = opts.batchDelay ?? 250;
    this.isUserActive = opts.isUserActive;
  }

  push(event: NotificationEvent): void {
    if (this.seen.has(event.dedupeKey)) return;
    this.seen.set(event.dedupeKey, Date.now());

    const active = this.isUserActive?.() ?? false;
    if (!shouldPush(event.kind, active)) return;

    if (!shouldAggregate(event.kind)) {
      this.flush();
      this.emit('notify', [event]);
      return;
    }

    this.batch.push(event);
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flush(), this.batchDelay);
    }
  }

  cancel(dedupeKey: string): boolean {
    const idx = this.batch.findIndex((e) => e.dedupeKey === dedupeKey);
    if (idx !== -1) {
      this.batch.splice(idx, 1);
      return true;
    }
    return false;
  }

  flush(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.batch.length > 0) {
      this.emit('notify', [...this.batch]);
      this.batch = [];
    }
  }

  prune(): void {
    const now = Date.now();
    for (const [key, ts] of this.seen) {
      if (now - ts > this.TTL) this.seen.delete(key);
    }
  }

  reset(): void {
    this.seen.clear();
    this.batch = [];
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }
}
