// src/im/hud/feishu-panel.ts

import type { PlatformAdapter } from '../../platform/types.js';
import type { RenderTarget } from '../render-target.js';
import type { HudPanel } from './panel.js';
import type { HudState } from './state.js';
import { buildFeishuHudCard } from './format-feishu.js';

type CardCapable = PlatformAdapter & {
  sendCard?: (opts: { chatId: string; threadId?: string; card: object }) => Promise<string>;
  updateCard?: (msgId: string, chatId: string, card: object) => Promise<void>;
};

export class FeishuHudPanel implements HudPanel {
  private lastHash: string | null = null;

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly target: RenderTarget,
  ) {}

  async send(state: HudState): Promise<string> {
    const adapter = this.adapter as CardCapable;
    if (typeof adapter.sendCard !== 'function') {
      throw new Error('FeishuHudPanel requires adapter.sendCard');
    }
    const card = buildFeishuHudCard(state);
    this.lastHash = JSON.stringify(card);
    return await adapter.sendCard({
      chatId: this.target.chatId,
      threadId: this.target.threadId,
      card,
    });
  }

  async update(msgId: string, state: HudState): Promise<void> {
    const adapter = this.adapter as CardCapable;
    if (typeof adapter.updateCard !== 'function') {
      throw new Error('FeishuHudPanel requires adapter.updateCard');
    }
    const card = buildFeishuHudCard(state);
    const hash = JSON.stringify(card);
    if (hash === this.lastHash) return;
    this.lastHash = hash;
    try {
      await adapter.updateCard(msgId, this.target.chatId, card);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[hud-update] target=fs:${this.target.chatId} reason=${reason}\n`);
    }
  }

  async freeze(msgId: string, state: HudState): Promise<void> {
    const adapter = this.adapter as CardCapable;
    if (typeof adapter.updateCard !== 'function') return;
    const card = buildFeishuHudCard(state);
    this.lastHash = JSON.stringify(card);
    try {
      await adapter.updateCard(msgId, this.target.chatId, card);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[hud-freeze] target=fs:${this.target.chatId} reason=${reason}\n`);
    }
  }
}
