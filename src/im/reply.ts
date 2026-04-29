// src/im/reply.ts
//
// ReplyRenderer — streaming agent text. NO footer (HUD owns stats).
// One reply msgId per turn for primaries; mirrors emit ONE send on complete only.
// Telegram: HTML-formatted text, send first then edit on deltas; >4096 char
// chunked into linked replies. Feishu: lark card with single markdown element,
// sendCard once + updateCard on deltas.

import type { PlatformAdapter } from '../platform/types.js';
import type { RenderTarget } from './render-target.js';

const TG_MAX = 4096;

type CardCapable = PlatformAdapter & {
  sendCard?: (opts: { chatId: string; threadId?: string; card: object }) => Promise<string>;
  updateCard?: (msgId: string, chatId: string, card: object) => Promise<void>;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function markdownToTelegramHtml(md: string): string {
  // Order matters: handle code fences first (so inline syntax inside fences
  // is preserved), then inline code, bold, italic.
  // NUL-byte sentinel: cannot survive escapeHtml below (it doesn't strip NUL,
  // but NUL never appears in normal user text from the agent stream), and
  // cannot collide with user content like the literal substring "FENCE0".
  const fences: string[] = [];
  const SENTINEL_OPEN = ' \x00F\x00 ';
  const SENTINEL_CLOSE = ' \x00E\x00 ';
  let out = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, body) => {
    const idx = fences.length;
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    fences.push(`<pre><code${langAttr}>${escapeHtml(body)}</code></pre>`);
    return `${SENTINEL_OPEN}${idx}${SENTINEL_CLOSE}`;
  });
  out = escapeHtml(out);
  out = out.replace(/`([^`\n]+)`/g, (_, x) => `<code>${x}</code>`);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, x) => `<b>${x}</b>`);
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_, p, x) => `${p}<i>${x}</i>`);
  // Restore fenced blocks.
  const restoreRe = new RegExp(` \x00F\x00 (\\d+) \x00E\x00 `, 'g');
  out = out.replace(restoreRe, (_, i) => fences[Number(i)] ?? '');
  return out;
}

export function chunkForTelegram(text: string): string[] {
  if (text.length <= TG_MAX) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TG_MAX) {
    let cut = remaining.lastIndexOf('\n', TG_MAX);
    if (cut <= 0) cut = TG_MAX;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export class ReplyRenderer {
  private headMsgId: string | null = null;
  // Per-overflow-chunk msgId or null if the prior send failed. Length tracks
  // how many chunks we've ATTEMPTED so subsequent deltas don't re-send.
  private overflowMsgIds: Array<string | null> = [];
  private lastRendered = '';
  private mirrorBuffer = '';

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly target: RenderTarget,
  ) {}

  /** Streaming text update — accumulated text so far (not just the new portion). */
  async onTextDelta(accumulated: string): Promise<void> {
    if (this.target.role === 'mirror') {
      // Buffer until complete; mirror sends one final message per turn.
      this.mirrorBuffer = accumulated;
      return;
    }
    await this.render(accumulated);
  }

  /** Final text — buffered mirrors flush here; primaries render the final state. */
  async onTextComplete(text: string): Promise<void> {
    if (this.target.role === 'mirror') {
      this.mirrorBuffer = text;
      await this.flushMirror();
      return;
    }
    await this.render(text);
  }

  private async flushMirror(): Promise<void> {
    if (this.headMsgId !== null) return;
    if (this.target.channelType === 'feishu') {
      const adapter = this.adapter as CardCapable;
      if (typeof adapter.sendCard !== 'function') {
        throw new Error('FeishuReply requires adapter.sendCard');
      }
      const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: this.mirrorBuffer }] } };
      try {
        const id = await adapter.sendCard({
          chatId: this.target.chatId, threadId: this.target.threadId, card,
        });
        this.headMsgId = id;
        this.mirrorBuffer = '';
      } catch (err) {
        process.stderr.write(`[reply-mirror] target=fs:${this.target.chatId} reason=${(err as Error).message}\n`);
      }
      return;
    }
    const html = markdownToTelegramHtml(this.mirrorBuffer);
    try {
      const id = await this.adapter.send({
        chatId: this.target.chatId,
        threadId: this.target.threadId,
        text: html.length > TG_MAX ? html.slice(0, TG_MAX - 1) + '…' : html,
        parseMode: 'html',
      });
      this.headMsgId = id;
      this.mirrorBuffer = '';
    } catch (err) {
      process.stderr.write(`[reply-mirror] target=tg:${this.target.chatId} reason=${(err as Error).message}\n`);
    }
  }

  private async render(text: string): Promise<void> {
    if (this.target.channelType === 'feishu') {
      await this.renderFeishu(text);
      return;
    }
    await this.renderTelegram(text);
  }

  private async renderTelegram(text: string): Promise<void> {
    const html = markdownToTelegramHtml(text);
    const chunks = chunkForTelegram(html);
    if (this.headMsgId === null) {
      try {
        const id = await this.adapter.send({
          chatId: this.target.chatId,
          threadId: this.target.threadId,
          text: chunks[0],
          parseMode: 'html',
        });
        this.headMsgId = id;
        this.lastRendered = chunks[0] ?? '';
      } catch (err) {
        process.stderr.write(`[reply-send] target=tg:${this.target.chatId} reason=${(err as Error).message}\n`);
        return;
      }
      for (let i = 1; i < chunks.length; i++) {
        try {
          const ofId = await this.adapter.send({
            chatId: this.target.chatId,
            threadId: this.target.threadId,
            text: chunks[i],
            parseMode: 'html',
            replyToMessageId: this.headMsgId,
          });
          this.overflowMsgIds.push(ofId);
        } catch (err) {
          process.stderr.write(`[reply-overflow] target=tg:${this.target.chatId} reason=${(err as Error).message}\n`);
          this.overflowMsgIds.push(null);
        }
      }
      return;
    }

    if (chunks[0] !== this.lastRendered) {
      this.lastRendered = chunks[0] ?? '';
      try {
        await this.adapter.edit(this.headMsgId, this.target.chatId, chunks[0], undefined, 'html');
      } catch (err) {
        process.stderr.write(`[reply-edit] target=tg:${this.target.chatId} reason=${(err as Error).message}\n`);
      }
    }
    // Append new overflow chunks if text grew.
    for (let i = 1 + this.overflowMsgIds.length; i < chunks.length; i++) {
      try {
        const ofId = await this.adapter.send({
          chatId: this.target.chatId,
          threadId: this.target.threadId,
          text: chunks[i],
          parseMode: 'html',
          replyToMessageId: this.headMsgId,
        });
        this.overflowMsgIds.push(ofId);
      } catch (err) {
        process.stderr.write(`[reply-overflow] target=tg:${this.target.chatId} reason=${(err as Error).message}\n`);
        this.overflowMsgIds.push(null);
      }
    }
  }

  private async renderFeishu(text: string): Promise<void> {
    const adapter = this.adapter as CardCapable;
    if (typeof adapter.sendCard !== 'function') {
      throw new Error('FeishuReply requires adapter.sendCard');
    }
    const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } };
    if (this.headMsgId === null) {
      try {
        const id = await adapter.sendCard({
          chatId: this.target.chatId, threadId: this.target.threadId, card,
        });
        this.headMsgId = id;
      } catch (err) {
        process.stderr.write(`[reply-send] target=fs:${this.target.chatId} reason=${(err as Error).message}\n`);
      }
      return;
    }
    if (typeof adapter.updateCard !== 'function') return;
    try {
      await adapter.updateCard(this.headMsgId, this.target.chatId, card);
    } catch (err) {
      process.stderr.write(`[reply-update] target=fs:${this.target.chatId} reason=${(err as Error).message}\n`);
    }
  }
}
