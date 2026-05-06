// src/im/reply-document/reply-document.ts
//
// v3.2 (2026-04-30): Telegram path becomes 2-message structure
//   m1 = reply head (banner + progress + body[0])
//   m2 = detail card (<pre><code>) replyTo m1
//   bodyChunkMsgIds[i] = overflow chunks (replyTo m1) when body >4096 chars
//
// On state-only changes (tool tally, elapsed tick), m1 + m2 + any
// overflow chunks all get re-edited (live elapsed renders into all of
// them via Date.now()).
//
// Feishu path stays single-card via sendCard/updateCard — lark supports
// large multi-element bodies natively, no chunking required.

import type { PlatformAdapter } from '../../platform/types.js';
import type { RenderTarget } from '../render-target.js';
import type { HudState } from '../hud/state.js';
import { EditQueue, CRITICAL, type Priority } from './edit-queue.js';
import { ReplyScheduler } from './scheduler.js';
import { renderTelegramReply, renderTelegramDetail } from './format-telegram.js';
import { renderFeishu } from './format-feishu.js';
import { chunkHtmlForTelegram } from './markdown.js';

const TELEGRAM_MAX = 4096;

export class ReplyDocument {
  // Telegram-only:
  private bodyMsgId: string | null = null;
  private bodyChunkMsgIds: string[] = [];
  private detailMsgId: string | null = null;
  // Feishu-only:
  private cardMsgId: string | null = null;

  private body = '';
  public readonly scheduler: ReplyScheduler;

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly target: RenderTarget,
    private readonly editQueue: EditQueue,
    private state: HudState,
  ) {
    this.scheduler = new ReplyScheduler((prio) => this.flushOnce(prio));
  }

  async start(): Promise<void> {
    if (this.target.channelType === 'telegram') {
      const reply = renderTelegramReply(this.state, this.body, Date.now());
      this.bodyMsgId = await this.adapter.send({
        chatId: this.target.chatId,
        threadId: this.target.threadId,
        text: reply.html,
        parseMode: 'html',
      });
      // Detail card sent as a separate adjacent message WITHOUT replyTo.
      // Telegram's replyTo creates an auto-quote bubble that duplicates
      // the parent's content above the detail, visually redundant. The
      // bot owns the conversation flow so adjacency is enough association.
      const detail = renderTelegramDetail(this.state);
      this.detailMsgId = await this.adapter.send({
        chatId: this.target.chatId,
        threadId: this.target.threadId,
        text: detail.html,
        parseMode: 'html',
        replyMarkup: detail.replyMarkup,
      });
    } else {
      if (typeof this.adapter.sendCard !== 'function') {
        throw new Error('feishu adapter requires sendCard');
      }
      const r = renderFeishu(this.state, this.body, Date.now());
      this.cardMsgId = await this.adapter.sendCard({
        chatId: this.target.chatId,
        threadId: this.target.threadId,
        card: r.card,
      });
    }
  }

  setBody(text: string): void { this.body = text; }
  setState(s: HudState): void { this.state = s; }
  setAskPending(p: boolean): void {
    this.state = { ...this.state, askPending: p };
    this.scheduler.setAskBlocked(p);
  }

  async freeze(s: HudState): Promise<void> {
    this.state = { ...s, isFrozen: true };
    await this.flushOnce(CRITICAL);
    this.scheduler.stop();
  }

  async markError(s: HudState, err: Error): Promise<void> {
    this.state = { ...s, isErrored: true, errorSummary: err.message };
    await this.flushOnce(CRITICAL);
    this.scheduler.stop();
  }

  private async flushOnce(prio: Priority): Promise<void> {
    if (this.target.channelType === 'telegram') {
      await this.flushTelegram(prio);
    } else {
      await this.flushFeishu(prio);
    }
  }

  private async flushTelegram(prio: Priority): Promise<void> {
    if (!this.bodyMsgId) return;
    const bodyMsgId = this.bodyMsgId;
    const detailMsgId = this.detailMsgId;
    const chatId = this.target.chatId;
    const adapter = this.adapter;

    // Render reply (banner + progress + body) — chunk if >4096
    const reply = renderTelegramReply(this.state, this.body, Date.now());
    const chunks = chunkHtmlForTelegram(reply.html, TELEGRAM_MAX);

    // Edit head chunk (always m1)
    const headHtml = chunks[0];
    this.editQueue.enqueue(chatId, bodyMsgId, async () => {
      await adapter.edit(bodyMsgId, chatId, headHtml, undefined, 'html');
    }, prio);

    // Overflow chunks: append new ones via send, edit existing via EditQueue
    for (let i = 1; i < chunks.length; i++) {
      const chunkHtml = chunks[i];
      const existing = this.bodyChunkMsgIds[i - 1];
      if (existing) {
        this.editQueue.enqueue(chatId, existing, async () => {
          await adapter.edit(existing, chatId, chunkHtml, undefined, 'html');
        }, prio);
      } else {
        // New overflow chunk — synchronous send to capture msgId
        try {
          const newId = await adapter.send({
            chatId,
            threadId: this.target.threadId,
            text: chunkHtml,
            parseMode: 'html',
            replyToMessageId: bodyMsgId,
          });
          this.bodyChunkMsgIds.push(newId);
        } catch (err) {
          process.stderr.write(`[reply-doc] overflow send failed: ${(err as Error).message}\n`);
          break;
        }
      }
    }

    // Edit detail card (always edited on every flush — elapsed/cost may have ticked)
    if (detailMsgId) {
      const detail = renderTelegramDetail(this.state);
      const detailHtml = detail.html;
      const detailMarkup = detail.replyMarkup;
      this.editQueue.enqueue(chatId, detailMsgId, async () => {
        await adapter.edit(detailMsgId, chatId, detailHtml, detailMarkup, 'html');
      }, prio);
    }
  }

  private async flushFeishu(prio: Priority): Promise<void> {
    if (!this.cardMsgId) return;
    const cardMsgId = this.cardMsgId;
    const chatId = this.target.chatId;
    const adapter = this.adapter;
    const r = renderFeishu(this.state, this.body, Date.now());
    this.editQueue.enqueue(chatId, cardMsgId, async () => {
      if (typeof adapter.updateCard !== 'function') return;
      await adapter.updateCard(cardMsgId, chatId, r.card);
    }, prio);
  }
}
