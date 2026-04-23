// src/im/render/attachment-preview.ts
//
// Anchor #7 — attachment preview (spec §7.3). On `attachment_produced`, send
// the file as a platform-native attachment with a caption + Download button.
//
// AttachmentExporter is the upstream producer; this renderer only handles the
// outbound rendering, not the upload decision.

import type { RendererDeps, SessionRenderState, RenderTarget } from './types.js';
import type { ReplyMarkup } from '../../platform/types.js';

export interface AttachmentPreviewEvent {
  attachmentId: string;
  name: string;
  mime: string;
  sizeBytes: number;
  path: string;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

export function renderAttachmentCaption(ev: AttachmentPreviewEvent): string {
  return `📎 ${ev.name} · ${humanSize(ev.sizeBytes)}`;
}

export function attachmentButtons(attachmentId: string): ReplyMarkup {
  return {
    type: 'inline_keyboard',
    buttons: [[
      { text: '⬇ Download', callbackData: `attach:download:${attachmentId}` },
    ]],
  };
}

export interface AttachmentPreviewRendererOptions extends RendererDeps {
  session: SessionRenderState;
}

export class AttachmentPreviewRenderer {
  private readonly adapter: AttachmentPreviewRendererOptions['adapter'];
  private readonly capabilities: AttachmentPreviewRendererOptions['capabilities'];
  private readonly session: SessionRenderState;

  constructor(opts: AttachmentPreviewRendererOptions) {
    this.adapter = opts.adapter;
    this.capabilities = opts.capabilities;
    this.session = opts.session;
  }

  async onProduced(ev: AttachmentPreviewEvent): Promise<void> {
    const caption = renderAttachmentCaption(ev);
    const markup = attachmentButtons(ev.attachmentId);
    for (const target of this.session.targets) {
      await this.renderForTarget(target, ev, caption, markup);
    }
  }

  private async renderForTarget(
    target: RenderTarget,
    ev: AttachmentPreviewEvent,
    caption: string,
    markup: ReplyMarkup,
  ): Promise<void> {
    const eff = target.role === 'primary' ? markup : undefined;
    if (this.capabilities.fileUpload) {
      try {
        await this.adapter.sendAttachment(
          target.chatId,
          { name: ev.name, mime: ev.mime, path: ev.path, caption },
          eff,
          target.threadId,
        );
        return;
      } catch { /* isolate; fall through to text-only preview */ }
    }
    await this.adapter.send({
      chatId: target.chatId,
      threadId: target.threadId,
      text: caption,
      replyMarkup: eff,
    });
  }
}
