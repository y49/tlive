// src/im/ask/ask-card-controller.ts
//
// AskCardController — owns per-turn ask card lifecycle:
//   - open(req): construct PermissionCard kind='ask', send, store by requestId
//   - markResolved(reqId, chosen): edit card to resolved visual, drop from store
//   - cancelPending(): forget all in-flight cards (turn_end / session-stop)
//
// Decoupled from frontend.ts so the wiring is testable in isolation. v1's
// activeAskCards path keeps running alongside this controller until T9
// removes the legacy code; both paths populate independent state, which is
// safe because PermissionCard's resolve is idempotent.

import type { PlatformAdapter } from '../../platform/types.js';
import type { RenderTarget } from '../render-target.js';
import type { AskUserQuestionRequest } from '../../runtime/types.js';
import { PermissionCard } from '../permission/card.js';
import { decideAskMode } from './ask-hook-input.js';

export class AskCardController {
  private readonly cards = new Map<string, PermissionCard>();

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly target: RenderTarget,
  ) {}

  async open(req: AskUserQuestionRequest): Promise<void> {
    const mode = decideAskMode(req.multiSelect ?? false, req.allowCustom ?? false);
    const card = new PermissionCard(this.adapter, this.target, {
      kind: 'ask',
      requestId: req.id,
      mode,
      question: req.prompt,
      header: req.header,
      options: req.options,
      onResolve: req.resolve,
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
}
