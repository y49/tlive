// src/im/render/queue-hint.ts
//
// Anchor #8 — queue hint (spec §7.3). When the user sends input while the
// agent is mid-turn, we render a reply-to-inbound message:
//   ⏭ Queued as #N · [cancel]
// CallbackRouter (T7) binds the cancel button to InputQueue.cancel.

import type { RendererDeps } from './types.js';
import type { ReplyMarkup } from '../../platform/types.js';

export interface QueueHintInput {
  chatId: string;
  threadId?: string;
  inboundMessageId: string;
  queuePosition: number;
  queueEntryId: string;
}

export function renderQueueHintText(queuePosition: number): string {
  return `⏭ Queued as #${queuePosition}`;
}

export function queueHintButtons(entryId: string): ReplyMarkup {
  return {
    type: 'inline_keyboard',
    buttons: [[
      { text: '❌ Cancel', callbackData: `queue:cancel:${entryId}`, style: 'danger' },
    ]],
  };
}

export class QueueHintRenderer {
  private readonly adapter: RendererDeps['adapter'];

  constructor(opts: RendererDeps) {
    this.adapter = opts.adapter;
  }

  async emit(input: QueueHintInput): Promise<string> {
    return this.adapter.send({
      chatId: input.chatId,
      threadId: input.threadId,
      replyToMessageId: input.inboundMessageId,
      text: renderQueueHintText(input.queuePosition),
      replyMarkup: queueHintButtons(input.queueEntryId),
      silent: true,
    });
  }
}
