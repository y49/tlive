// src/im/render/session-header.ts
//
// Anchor #2 — per-session pinned header (spec §7.3). One message per session
// per target, edited in place on state shifts (model/mode/cache/cost). Pinned
// when the platform supports it (Telegram & Feishu); skipped on Discord
// outside a thread.
//
// Content shape (single line, terse):
//   📁 {workspace} · 🧬 {short-alias} · 🤖 {model} · ⚡️ hot (Ns) · 💰 $0.12

import type { RendererDeps, SessionRenderState, RenderTarget } from './types.js';
import { targetKey } from './types.js';
import { formatCacheBadge } from './cache-badge.js';

export interface SessionHeaderData {
  workspaceName: string;
  shortAlias: string;
  model?: string;
  modeLabel?: string;
  cacheWarmUntilMs?: number | null;
  costUsd: number;
}

export function renderSessionHeaderText(data: SessionHeaderData, nowMs = Date.now()): string {
  const parts: string[] = [];
  parts.push(`📁 ${data.workspaceName}`);
  parts.push(`🧬 ${data.shortAlias}`);
  if (data.model) parts.push(`🤖 ${data.model}`);
  if (data.modeLabel) parts.push(data.modeLabel);
  const cache = formatCacheBadge({ warmUntilMs: data.cacheWarmUntilMs, nowMs });
  if (cache) parts.push(cache);
  parts.push(`💰 $${data.costUsd.toFixed(2)}`);
  return parts.join(' · ');
}

export interface SessionHeaderRendererOptions extends RendererDeps {
  session: SessionRenderState;
}

export class SessionHeaderRenderer {
  private readonly adapter: SessionHeaderRendererOptions['adapter'];
  private readonly capabilities: SessionHeaderRendererOptions['capabilities'];
  private readonly session: SessionRenderState;
  private readonly lastTextByTarget = new Map<string, string>();

  constructor(opts: SessionHeaderRendererOptions) {
    this.adapter = opts.adapter;
    this.capabilities = opts.capabilities;
    this.session = opts.session;
  }

  /** Send the initial header for every target. Pins when supported. */
  async initialize(nowMs = Date.now()): Promise<void> {
    const text = renderSessionHeaderText(this.headerData(), nowMs);
    for (const target of this.session.targets) {
      await this.sendForTarget(target, text);
    }
  }

  /** Re-render header (edit if id known, else create). */
  async refresh(nowMs = Date.now()): Promise<void> {
    const text = renderSessionHeaderText(this.headerData(), nowMs);
    for (const target of this.session.targets) {
      const key = targetKey(target);
      const prev = this.lastTextByTarget.get(key);
      if (prev === text) continue;
      const id = this.session.sessionHeaderMsgIds.get(key);
      if (id && this.capabilities.editMessage) {
        try {
          await this.adapter.edit(id, target.chatId, text);
          this.lastTextByTarget.set(key, text);
          continue;
        } catch { /* fall through to re-send */ }
      }
      await this.sendForTarget(target, text);
    }
  }

  /** Delete header messages (called on session stop). */
  async teardown(): Promise<void> {
    for (const target of this.session.targets) {
      const key = targetKey(target);
      const id = this.session.sessionHeaderMsgIds.get(key);
      if (!id) continue;
      try { await this.adapter.delete(id, target.chatId); } catch { /* isolate */ }
      this.session.sessionHeaderMsgIds.delete(key);
    }
    this.lastTextByTarget.clear();
  }

  private headerData(): SessionHeaderData {
    return {
      workspaceName: this.session.workspaceName,
      shortAlias: this.session.shortAlias,
      model: this.session.model,
      modeLabel: this.session.modeLabel,
      cacheWarmUntilMs: this.session.cacheWarmUntilMs,
      costUsd: this.session.costUsd,
    };
  }

  private async sendForTarget(target: RenderTarget, text: string): Promise<void> {
    const key = targetKey(target);
    const id = await this.adapter.send({
      chatId: target.chatId,
      threadId: target.threadId,
      text,
      silent: true,
    });
    this.session.sessionHeaderMsgIds.set(key, id);
    this.lastTextByTarget.set(key, text);
    if (this.capabilities.pinMessage) {
      try { await this.adapter.pin(id, target.chatId); } catch { /* isolate */ }
    }
  }
}
