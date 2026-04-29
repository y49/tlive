// src/im/hud/telegram-panel.ts

import type { PlatformAdapter } from '../../platform/types.js';
import type { RenderTarget } from '../render-target.js';
import type { HudPanel } from './panel.js';
import type { HudState } from './state.js';
import { formatTelegramHud } from './format-telegram.js';

export class TelegramHudPanel implements HudPanel {
  private lastHash: string | null = null;

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly target: RenderTarget,
  ) {}

  async send(state: HudState): Promise<string> {
    const text = formatTelegramHud(state);
    this.lastHash = text;
    return await this.adapter.send({
      chatId: this.target.chatId,
      threadId: this.target.threadId,
      text,
      parseMode: 'html',
    });
  }

  async update(msgId: string, state: HudState): Promise<void> {
    const text = formatTelegramHud(state);
    if (text === this.lastHash) return;
    this.lastHash = text;
    try {
      await this.adapter.edit(msgId, this.target.chatId, text, undefined, 'html');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[hud-update] target=tg:${this.target.chatId} reason=${reason}\n`);
    }
  }

  async freeze(msgId: string, state: HudState): Promise<void> {
    const text = formatTelegramHud(state);
    this.lastHash = text;
    try {
      await this.adapter.edit(msgId, this.target.chatId, text, undefined, 'html');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[hud-freeze] target=tg:${this.target.chatId} reason=${reason}\n`);
    }
  }
}
