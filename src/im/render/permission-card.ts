// src/im/render/permission-card.ts
//
// Anchor #5 — permission card (spec §7.3). Four category templates:
//   - exec: shell block + risk badge + Allow/Deny/Always/Learn.
//   - file-edit: unified diff preview + stats + Allow/Deny/Always/Learn.
//   - generic: tool name + JSON input + Allow/Deny/Always/Learn.
//   - elicitation: handled by ElicitationFormRenderer — this file rejects the
//     category so we don't double-route.
//
// Card lifecycle:
//   pending(ev) → render create, map requestId → msgId.
//   resolved(decision) → edit to "resolved" banner, clear inline buttons.
//
// v1.0 — renderer-per-target. Mirrors omit interactive buttons and append a
// "Respond from primary chat" footer.

import type { PermissionRequest } from '../../runtime/types.js';
import type { PermissionDecision } from '../../runtime/types.js';
import type { RendererDeps, SessionRenderState, RenderTarget } from './types.js';
import { targetKey } from './types.js';
import type { InlineButton, ReplyMarkup } from '../../platform/types.js';

export interface PermissionCardRendererOptions extends RendererDeps {
  session: SessionRenderState;
}

function riskBadge(risk: 'low' | 'medium' | 'high' | undefined): string {
  switch (risk) {
    case 'high': return '🚨 high-risk';
    case 'medium': return '⚠️ medium-risk';
    case 'low': return '· low-risk';
    default: return '';
  }
}

function fence(lang: string, body: string): string {
  const trimmed = body.length > 800 ? body.slice(0, 800) + '\n…(truncated)' : body;
  return '```' + lang + '\n' + trimmed + '\n```';
}

function formatJson(v: unknown): string {
  try {
    return fence('json', JSON.stringify(v, null, 2));
  } catch {
    return String(v);
  }
}

/** Build a unified-diff view from a diffPreview. */
function renderDiff(preview: PermissionRequest['diffPreview']): string {
  if (!preview) return '';
  const head = preview.path ? `--- ${preview.path}\n+++ ${preview.path}\n` : '';
  const body = [
    ...(preview.from ? preview.from.split('\n').map((l) => `- ${l}`) : []),
    ...(preview.to ? preview.to.split('\n').map((l) => `+ ${l}`) : []),
  ].join('\n');
  return fence('diff', head + body);
}

export function renderPermissionCard(req: PermissionRequest): string {
  switch (req.category) {
    case 'exec': {
      const input = (req.toolInput ?? {}) as { command?: string; description?: string };
      const parts: string[] = [];
      parts.push(`🔒 Permission · 🛠 ${req.toolName}`);
      if (input.description) parts.push(input.description);
      if (input.command) parts.push(fence('bash', input.command));
      const rb = riskBadge(req.risk);
      if (rb) parts.push(rb);
      return parts.join('\n');
    }
    case 'file-edit': {
      const input = (req.toolInput ?? {}) as { path?: string; file_path?: string };
      const path = input.path ?? input.file_path ?? req.diffPreview?.path;
      const parts: string[] = [];
      parts.push(`🔒 Permission · 📝 ${req.toolName}${path ? ` · ${path}` : ''}`);
      if (req.diffPreview) {
        parts.push(`+${req.diffPreview.added} -${req.diffPreview.removed}`);
        const diff = renderDiff(req.diffPreview);
        if (diff) parts.push(diff);
      } else {
        parts.push(formatJson(req.toolInput));
      }
      const rb = riskBadge(req.risk);
      if (rb) parts.push(rb);
      return parts.join('\n');
    }
    case 'generic': {
      const parts: string[] = [];
      parts.push(`🔒 Permission · 🧩 ${req.toolName}`);
      parts.push(formatJson(req.toolInput));
      const rb = riskBadge(req.risk);
      if (rb) parts.push(rb);
      return parts.join('\n');
    }
    case 'elicitation':
      return `🔒 Elicitation · ${req.toolName}`;
  }
}

export function permissionButtons(requestId: string): ReplyMarkup {
  const row1: InlineButton[] = [
    { text: '✅ Allow', callbackData: `perm:allow:${requestId}`, style: 'primary' },
    { text: '❌ Deny', callbackData: `perm:deny:${requestId}`, style: 'danger' },
  ];
  const row2: InlineButton[] = [
    { text: '🔁 Always', callbackData: `perm:always:${requestId}`, style: 'default' },
    { text: '💡 Learn', callbackData: `perm:learn:${requestId}`, style: 'default' },
  ];
  return { type: 'inline_keyboard', buttons: [row1, row2] };
}

function renderResolvedBanner(decision: PermissionDecision, userId?: string): string {
  const who = userId ? ` by @${userId}` : '';
  switch (decision) {
    case 'allow': return `✅ Allowed${who}`;
    case 'deny': return `❌ Denied${who}`;
    case 'allow_always': return `🔁 Allow-always${who}`;
  }
}

export class PermissionCardRenderer {
  private readonly adapter: PermissionCardRendererOptions['adapter'];
  private readonly capabilities: PermissionCardRendererOptions['capabilities'];
  private readonly session: SessionRenderState;
  private readonly target: RenderTarget;

  constructor(opts: PermissionCardRendererOptions) {
    this.adapter = opts.adapter;
    this.capabilities = opts.capabilities;
    this.session = opts.session;
    this.target = opts.target;
  }

  async onPending(req: PermissionRequest): Promise<void> {
    if (req.category === 'elicitation') return; // Routed to ElicitationFormRenderer.
    const text = renderPermissionCard(req);
    const markup = permissionButtons(req.id);
    await this.sendForTarget(req.id, text, markup);
  }

  async onResolved(requestId: string, decision: PermissionDecision, resolvedByUserId?: string): Promise<void> {
    const banner = renderResolvedBanner(decision, resolvedByUserId);
    const target = this.target;
    const key = targetKey(target);
    const perTarget = this.session.pendingPermissionMsgIds.get(key);
    const msgId = perTarget?.get(requestId);
    if (!msgId) return;
    if (this.capabilities.editMessage) {
      // Append banner + strip buttons.
      try {
        await this.adapter.edit(msgId, target.chatId, banner, { type: 'inline_keyboard', buttons: [] });
      } catch { /* isolate */ }
    } else {
      try {
        await this.adapter.send({
          chatId: target.chatId,
          threadId: target.threadId,
          text: banner,
          replyToMessageId: msgId,
          silent: true,
        });
      } catch { /* isolate */ }
    }
    perTarget!.delete(requestId);
    if (perTarget!.size === 0) this.session.pendingPermissionMsgIds.delete(key);
  }

  private async sendForTarget(
    requestId: string,
    text: string,
    markup: ReplyMarkup,
  ): Promise<void> {
    const target = this.target;
    const effectiveMarkup = target.role === 'primary' ? markup : undefined;
    const mirrorTail = target.role === 'mirror' ? `\n(Respond from primary chat)` : '';
    const sent = await this.adapter.send({
      chatId: target.chatId,
      threadId: target.threadId,
      text: text + mirrorTail,
      replyMarkup: effectiveMarkup,
    });
    const key = targetKey(target);
    let perTarget = this.session.pendingPermissionMsgIds.get(key);
    if (!perTarget) {
      perTarget = new Map();
      this.session.pendingPermissionMsgIds.set(key, perTarget);
    }
    perTarget.set(requestId, sent);
  }
}
