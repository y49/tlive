// src/im/reply-document/reply-document.ts
//
// ReplyDocument — owns the per-turn primary reply message (banner+body+footer
// for Telegram, lark card 2.0 for Feishu). Body comes from assistant text
// stream, state from HudState reducer. All edits go through EditQueue with
// per-event priority. start() sends placeholder; setBody/setState mark dirty;
// scheduler.schedule fires render→queue.enqueue; freeze/markError end the turn.

import type { PlatformAdapter } from '../../platform/types.js';
import type { RenderTarget } from '../render-target.js';
import type { HudState } from '../hud/state.js';
import { EditQueue, CRITICAL, type Priority } from './edit-queue.js';
import { ReplyScheduler } from './scheduler.js';
import { renderTelegram, type TelegramRender } from './format-telegram.js';
import { renderFeishu, type FeishuRender } from './format-feishu.js';

export class ReplyDocument {
  private msgId: string | null = null;
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
      const r = renderTelegram(this.state, this.body);
      this.msgId = await this.adapter.send({
        chatId: this.target.chatId,
        threadId: this.target.threadId,
        text: r.html,
        parseMode: 'html',
      });
    } else {
      const r = renderFeishu(this.state, this.body);
      if (typeof this.adapter.sendCard !== 'function') throw new Error('feishu adapter requires sendCard');
      this.msgId = await this.adapter.sendCard({
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
    if (!this.msgId) return;
    const msgId = this.msgId;
    if (this.target.channelType === 'telegram') {
      const r: TelegramRender = renderTelegram(this.state, this.body);
      this.editQueue.enqueue(this.target.chatId, msgId, async () => {
        await this.adapter.edit(msgId, this.target.chatId, r.html, undefined, 'html');
      }, prio);
    } else {
      const r: FeishuRender = renderFeishu(this.state, this.body);
      this.editQueue.enqueue(this.target.chatId, msgId, async () => {
        if (typeof this.adapter.updateCard !== 'function') return;
        await this.adapter.updateCard(msgId, this.target.chatId, r.card);
      }, prio);
    }
  }
}
