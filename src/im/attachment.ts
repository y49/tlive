// src/im/attachment.ts
//
// AttachmentPreview — send-only preview for `attachment_produced` events.
// One message per attachment (no editing, no state machine). Telegram: plain
// HTML text. Feishu: lark card with markdown element; falls back to plain
// send when adapter doesn't expose sendCard.

import type { PlatformAdapter } from '../platform/types.js';
import type { RenderTarget } from './render-target.js';
import { escapeHtml } from './util/html.js';

export interface AttachmentPayload {
  name: string;
  mime: string;
  sizeBytes: number;
  path: string;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class AttachmentPreview {
  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly target: RenderTarget,
  ) {}

  async send(p: AttachmentPayload): Promise<void> {
    const adapter = this.adapter;
    const safeName = escapeHtml(p.name);
    const sizeStr = fmtSize(p.sizeBytes);

    if (this.target.channelType === 'feishu' && typeof adapter.sendCard === 'function') {
      const card = {
        schema: '2.0',
        body: { elements: [{ tag: 'markdown', content: `📎 **${safeName}** · ${sizeStr}` }] },
      };
      try {
        await adapter.sendCard({
          chatId: this.target.chatId,
          threadId: this.target.threadId,
          card,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[attachment-send] target=fs:${this.target.chatId} reason=${reason}\n`);
      }
      return;
    }

    try {
      await this.adapter.send({
        chatId: this.target.chatId,
        threadId: this.target.threadId,
        text: `📎 ${safeName} · ${sizeStr}`,
        parseMode: 'html',
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[attachment-send] target=${this.target.channelType}:${this.target.chatId} reason=${reason}\n`);
    }
  }
}
