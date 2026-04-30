// src/im/turn-composite.ts
//
// TurnComposite — owns the per-turn primary reply through ReplyDocument;
// routes NotificationEvents through reducer + setBody/setState. Bounded by
// start()..destroy(); destroy is set on turn_end + 30s grace.

import type { PlatformAdapter } from '../platform/types.js';
import type { RenderTarget } from './render-target.js';
import type { NotificationEvent } from '../runtime/events.js';
import type { HudState } from './hud/state.js';
import { applyEventToHudState } from './hud/reducer.js';
import { ReplyDocument } from './reply-document/reply-document.js';
import { EditQueue, NORMAL, CRITICAL } from './reply-document/edit-queue.js';

const DESTROY_GRACE_MS = 30_000;

export class TurnComposite {
  readonly replyDocument: ReplyDocument;
  private state: HudState;
  private bodyAcc = '';
  private destroyed = false;
  private destroyTimer: NodeJS.Timeout | null = null;

  constructor(
    adapter: PlatformAdapter,
    target: RenderTarget,
    editQueue: EditQueue,
    initialState: HudState,
  ) {
    this.state = initialState;
    this.replyDocument = new ReplyDocument(adapter, target, editQueue, initialState);
  }

  async start(): Promise<void> {
    await this.replyDocument.start();
  }

  ingestEvent(ev: NotificationEvent): void {
    if (this.destroyed) return;
    const next = applyEventToHudState(this.state, ev);
    if (next !== this.state) {
      this.state = next;
      this.replyDocument.setState(next);
    }

    if (ev.kind === 'assistant_text_delta') {
      this.bodyAcc += ev.text;
      this.replyDocument.setBody(this.bodyAcc);
      this.replyDocument.scheduler.schedule('event', NORMAL);
      return;
    }
    if (ev.kind === 'assistant_text') {
      this.bodyAcc = ev.text;
      this.replyDocument.setBody(this.bodyAcc);
      this.replyDocument.scheduler.schedule('event', NORMAL);
      return;
    }
    if (ev.kind === 'ask_user_question_requested') {
      this.replyDocument.setAskPending(true);
      this.replyDocument.scheduler.schedule('event', CRITICAL);
      return;
    }
    if (ev.kind === 'ask_user_question_resolved') {
      this.replyDocument.setAskPending(false);
      this.replyDocument.scheduler.schedule('event', CRITICAL);
      return;
    }
    if (ev.kind === 'turn_end') {
      void this.replyDocument.freeze(this.state);
      this.scheduleDestroy();
      return;
    }
    if (ev.kind === 'runtime_error' && ev.severity === 'fatal') {
      void this.replyDocument.markError(this.state, new Error(ev.message));
      this.scheduleDestroy();
      return;
    }
    this.replyDocument.scheduler.schedule('event', NORMAL);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.destroyTimer) { clearTimeout(this.destroyTimer); this.destroyTimer = null; }
    this.replyDocument.scheduler.stop();
  }

  isDestroyed(): boolean { return this.destroyed; }

  private scheduleDestroy(): void {
    if (this.destroyTimer) return;
    this.destroyTimer = setTimeout(() => this.destroy(), DESTROY_GRACE_MS);
  }
}
