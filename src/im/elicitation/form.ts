// src/im/elicitation/form.ts
//
// Renders MCP ElicitationRequest via the platform's native primitive
// (spec §7.3 item 5 / §10). Three modes:
//   - 'form'     → platform modal/form (Feishu form card, or Telegram
//                  forceReply sequence in ordered fields).
//   - 'confirm'  → two-button inline card.
//   - 'url-auth' → card with a single URL button.
//
// Scope: this renderer produces the outbound card. T7's CommandRouter handles
// the inbound `form_submit` event and calls ElicitationBroker.resolve().
//
// v1.0 — renderer-per-target. Form mode dispatches per-platform:
//   Feishu : calls FeishuAdapter.sendFormCard(...) directly (Feishu's form
//            card can't be emitted through buildInlineCard).
//   Telegram: forceReply sequence (existing path).

import type { ElicitationRequest } from '../../runtime/types.js';
import type { RendererDeps, SessionRenderState, RenderTarget } from '../render/types.js';
import { targetKey } from '../render/types.js';
import type { FormField, ReplyMarkup } from '../../platform/types.js';
import type { FeishuAdapter } from '../../platform/feishu/adapter.js';

export interface ElicitationFormRendererOptions extends RendererDeps {
  session: SessionRenderState;
}

function schemaToFields(schema: ElicitationRequest['schema']): FormField[] {
  if (!schema) return [];
  return Object.entries(schema).map(([name, def]) => ({
    name,
    label: def.description ?? name,
    type: def.type === 'string' ? 'text' : def.type === 'text' ? 'textarea' : 'text',
    required: def.required ?? false,
    default: def.default !== undefined ? String(def.default) : undefined,
  }));
}

export function renderElicitationText(req: ElicitationRequest): string {
  const title = `🧩 ${req.mcpServerName}`;
  const desc = req.description ?? '';
  return desc ? `${title}\n${desc}` : title;
}

export function buildElicitationMarkup(
  req: ElicitationRequest,
  modalCapable: boolean,
): ReplyMarkup {
  if (req.mode === 'confirm') {
    return {
      type: 'inline_keyboard',
      buttons: [[
        { text: '✅ Accept', callbackData: `elic:accept:${req.id}`, style: 'primary' },
        { text: '❌ Decline', callbackData: `elic:decline:${req.id}`, style: 'danger' },
      ]],
    };
  }
  if (req.mode === 'url-auth') {
    const url = req.url ?? '#';
    return {
      type: 'inline_keyboard',
      buttons: [[
        { text: '🔗 Open auth', url },
        { text: '❌ Cancel', callbackData: `elic:decline:${req.id}`, style: 'danger' },
      ]],
    };
  }
  // form mode
  const fields = schemaToFields(req.schema);
  if (modalCapable) {
    return {
      type: 'modal',
      title: req.mcpServerName,
      formFields: fields,
      buttons: [[
        { text: 'Submit', callbackData: `elic:submit:${req.id}`, style: 'primary' },
        { text: 'Cancel', callbackData: `elic:decline:${req.id}`, style: 'danger' },
      ]],
    };
  }
  // No modal → force-reply sequence. Kick off by listing fields + first
  // question. T7's CommandRouter aggregates subsequent answers.
  const firstField = fields[0];
  return {
    type: 'force_reply',
    placeholder: firstField ? firstField.label : 'Reply to submit',
    formFields: fields,
    buttons: [[
      { text: '❌ Cancel', callbackData: `elic:decline:${req.id}`, style: 'danger' },
    ]],
  };
}

/**
 * Type guard: duck-typed detection of FeishuAdapter's `sendFormCard`. We
 * don't `instanceof` because tests pass fake adapters.
 */
function asFeishuAdapter(
  adapter: unknown,
): { sendFormCard: FeishuAdapter['sendFormCard'] } | null {
  if (typeof adapter !== 'object' || adapter === null) return null;
  const sf = (adapter as { sendFormCard?: unknown }).sendFormCard;
  if (typeof sf !== 'function') return null;
  return adapter as { sendFormCard: FeishuAdapter['sendFormCard'] };
}

export class ElicitationFormRenderer {
  private readonly adapter: ElicitationFormRendererOptions['adapter'];
  private readonly capabilities: ElicitationFormRendererOptions['capabilities'];
  private readonly session: SessionRenderState;
  private readonly target: RenderTarget;

  constructor(opts: ElicitationFormRendererOptions) {
    this.adapter = opts.adapter;
    this.capabilities = opts.capabilities;
    this.session = opts.session;
    this.target = opts.target;
  }

  async onPending(req: ElicitationRequest): Promise<void> {
    const text = renderElicitationText(req);
    await this.sendForTarget(req, text);
  }

  async onResolved(requestId: string, action: 'accept' | 'decline'): Promise<void> {
    const banner = action === 'accept' ? '✅ Submitted' : '❌ Declined';
    const target = this.target;
    const key = targetKey(target);
    const perTarget = this.session.pendingElicitationMsgIds.get(key);
    const msgId = perTarget?.get(requestId);
    if (!msgId) return;
    if (this.capabilities.editMessage) {
      try {
        await this.adapter.edit(msgId, target.chatId, banner, { type: 'inline_keyboard', buttons: [] });
      } catch { /* isolate */ }
    }
    perTarget!.delete(requestId);
    if (perTarget!.size === 0) this.session.pendingElicitationMsgIds.delete(key);
  }

  private async sendForTarget(
    req: ElicitationRequest,
    text: string,
  ): Promise<void> {
    const target = this.target;
    const key = targetKey(target);

    // Mirrors always get a read-only echo.
    if (target.role === 'mirror') {
      const sent = await this.adapter.send({
        chatId: target.chatId,
        threadId: target.threadId,
        text,
      });
      this.recordMsgId(key, req.id, sent);
      return;
    }

    // Form mode on platforms with modalForm capability takes platform-
    // specific routing; all other modes use the generic markup.
    if (req.mode === 'form' && this.capabilities.modalForm) {
      if (target.channelType === 'feishu') {
        const f = asFeishuAdapter(this.adapter);
        if (f) {
          const fields = schemaToFields(req.schema);
          const sent = await f.sendFormCard(target.chatId, {
            title: req.mcpServerName,
            fields,
            submitId: req.id,
            threadId: target.threadId,
          });
          this.recordMsgId(key, req.id, sent);
          return;
        }
      }
    }

    // Generic path (confirm / url-auth / Telegram forceReply form / fallback).
    const markup = buildElicitationMarkup(req, this.capabilities.modalForm);
    const sent = await this.adapter.send({
      chatId: target.chatId,
      threadId: target.threadId,
      text,
      replyMarkup: markup,
    });
    this.recordMsgId(key, req.id, sent);
  }

  private recordMsgId(key: string, requestId: string, msgId: string): void {
    let perTarget = this.session.pendingElicitationMsgIds.get(key);
    if (!perTarget) {
      perTarget = new Map();
      this.session.pendingElicitationMsgIds.set(key, perTarget);
    }
    perTarget.set(requestId, msgId);
  }
}
