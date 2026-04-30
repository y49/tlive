// src/im/ask/ask-card-controller.ts
//
// AskCardController — owns per-turn ask card lifecycle:
//   - open(req): construct PermissionCard kind='ask', send, store by requestId
//   - markResolved(reqId, chosen): edit card to resolved visual, drop from store
//   - cancelPending(): forget all in-flight cards (turn_end / session-stop)
//
// Decoupled from frontend.ts so the wiring is testable in isolation. The
// frontend supplies the `resolve` callback so the broker is the single
// resolution path (callbacks must run through broker.resolve to clean up the
// pending registry and notify subscribers — calling req.resolve directly
// leaks the broker's pending map).

import type { PlatformAdapter } from '../../platform/types.js';
import type { RenderTarget } from '../render-target.js';
import type { AskUserQuestionRequest } from '../../runtime/types.js';
import { PermissionCard } from '../permission/card.js';
import { decideAskMode } from './ask-hook-input.js';

export type AskResolveFn = (requestId: string, chosen: string[]) => void;

export class AskCardController {
  private readonly cards = new Map<string, PermissionCard>();

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly target: RenderTarget,
    /**
     * Resolution callback. Defaults to invoking `req.resolve` directly (the
     * legacy behaviour preserved for the controller's own unit tests). The
     * frontend overrides with a broker-aware variant.
     */
    private readonly resolveFn?: AskResolveFn,
  ) {}

  async open(req: AskUserQuestionRequest): Promise<void> {
    const mode = decideAskMode(req.multiSelect ?? false, req.allowCustom ?? false);
    const onResolve = this.resolveFn
      ? (chosen: string[]) => this.resolveFn!(req.id, chosen)
      : req.resolve;
    const card = new PermissionCard(this.adapter, this.target, {
      kind: 'ask',
      requestId: req.id,
      mode,
      question: req.prompt,
      header: req.header,
      options: req.options,
      onResolve,
    });
    this.cards.set(req.id, card);
    await card.send();
  }

  async markResolved(reqId: string, chosen: string[]): Promise<void> {
    const card = this.cards.get(reqId);
    if (!card) return;
    await card.markResolvedAsk(chosen);
    this.cards.delete(reqId);
  }

  cancelPending(): void {
    this.cards.clear();
  }

  has(reqId: string): boolean { return this.cards.has(reqId); }

  /** Optional accessor used by callback-router refactor (T9). */
  getCard(reqId: string): PermissionCard | undefined { return this.cards.get(reqId); }

  /** Target this controller renders against — used by frontend routing. */
  getTarget(): RenderTarget { return this.target; }

  /** Iterable view of active cards — used by plaintext-relay routing. */
  activeCards(): IterableIterator<PermissionCard> { return this.cards.values(); }
}
