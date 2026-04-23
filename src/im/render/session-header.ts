// src/im/render/session-header.ts
//
// Anchor #2 — per-session pinned header (spec §7.3). One message per session
// per target, edited in place on state shifts (model/mode/cache/cost). Pinned
// when the platform supports it (Telegram & Feishu); skipped on Discord
// outside a thread.
//
// Content shape (single line, terse):
//   📁 {workspace} · 🧬 {short-alias} · 🤖 {model} · ⚡️ hot (Ns) · 💰 $0.12
//
// v1.0 — renderer-per-target: one SessionHeaderRenderer per binding.

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
  private readonly target: RenderTarget;
  private lastText: string | undefined;

  constructor(opts: SessionHeaderRendererOptions) {
    this.adapter = opts.adapter;
    this.capabilities = opts.capabilities;
    this.session = opts.session;
    this.target = opts.target;
  }

  /** Send the initial header for this target. Pins when supported. */
  async initialize(nowMs = Date.now()): Promise<void> {
    const text = renderSessionHeaderText(this.headerData(), nowMs);
    await this.sendForTarget(text);
  }

  /** Re-render header (edit if id known, else create). */
  async refresh(nowMs = Date.now()): Promise<void> {
    const text = renderSessionHeaderText(this.headerData(), nowMs);
    const target = this.target;
    const key = targetKey(target);
    if (this.lastText === text) return;
    const id = this.session.sessionHeaderMsgIds.get(key);
    if (id && this.capabilities.editMessage) {
      try {
        await this.adapter.edit(id, target.chatId, text);
        this.lastText = text;
        return;
      } catch { /* fall through to re-send */ }
    }
    await this.sendForTarget(text);
  }

  /** Delete header message (called on session stop). */
  async teardown(): Promise<void> {
    const target = this.target;
    const key = targetKey(target);
    const id = this.session.sessionHeaderMsgIds.get(key);
    if (!id) return;
    try { await this.adapter.delete(id, target.chatId); } catch { /* isolate */ }
    this.session.sessionHeaderMsgIds.delete(key);
    this.lastText = undefined;
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

  private async sendForTarget(text: string): Promise<void> {
    const target = this.target;
    const key = targetKey(target);
    const id = await this.adapter.send({
      chatId: target.chatId,
      threadId: target.threadId,
      text,
      silent: true,
    });
    this.session.sessionHeaderMsgIds.set(key, id);
    this.lastText = text;
    if (this.capabilities.pinMessage) {
      try { await this.adapter.pin(id, target.chatId); } catch { /* isolate */ }
    }
  }
}
