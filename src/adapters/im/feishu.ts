// src/adapters/im/feishu.ts
//
// CRITICAL: WSClient holds a ref'd retry timer. stop() must call WSClient.close()
// AND null out our reference so GC can collect.
//
// Approval buttons use Feishu Card "callback" behaviors; taps arrive as
// `card.action.trigger` events and are mapped to an IncomingEnvelope whose
// text is the button id ("approve:<id>" / "deny:<id>") — same routing as
// Telegram's callback_query. NOTE: the exact card.action.trigger payload paths
// should be verified against a live Feishu app (no creds available in CI).

import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { IMAdapter, IncomingEnvelope, OutgoingMessage } from '../../kernel/contracts/im-adapter.js';
import { mdToFeishuElements } from './feishu-card.js';

export interface FeishuAdapterOpts {
  appId: string;
  appSecret: string;
  /** chat ID to send to; for now require single chat. */
  chatId?: string;
}

type CardMessage = Extract<OutgoingMessage, { kind: 'card' }>;

/** 按钮语义 → 飞书按钮样式:放行=primary、拒绝=danger,其余(Always allow /
 *  Pause / ask 选项…)一律 default —— 满屏 primary 会淹没真正的主动作。 */
function buttonType(id: string): 'primary' | 'danger' | 'default' {
  if (id.startsWith('approve:') || id.startsWith('asksubmit:')) return 'primary';
  if (id.startsWith('deny:')) return 'danger';
  return 'default';
}

/** Build a Feishu interactive card; approval buttons carry their id via a callback behavior.
 *  Body goes through the markdown converter (feishu-card.ts) — card 1.0 renders
 *  inline code / `> ` quotes literally, so the shared markdown must be adapted.
 *  Header gets the `blue` template only while the card is actionable, so a
 *  settled (edited) card visually steps back. */
export function buildCard(out: CardMessage): object {
  const elements: object[] = [...mdToFeishuElements(out.body)];
  if (out.buttons?.length) {
    elements.push({
      tag: 'action',
      actions: out.buttons.map((b) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: b.label },
        type: buttonType(b.id),
        behaviors: [{ type: 'callback', value: { tlive: b.id } }],
      })),
    });
  }
  return {
    config: { wide_screen_mode: true },
    ...(out.title
      ? {
          header: {
            title: { tag: 'plain_text', content: out.title },
            ...(out.buttons?.length ? { template: 'blue' } : {}),
          },
        }
      : {}),
    elements,
  };
}

export class FeishuAdapter implements IMAdapter {
  readonly channel = 'feishu' as const;
  private client: Client | null = null;
  private ws: WSClient | null = null;
  private inboundHandler?: (env: IncomingEnvelope) => void;
  private connected: 'connected' | 'idle' | 'failed' = 'idle';

  constructor(private opts: FeishuAdapterOpts) {}

  /** Download an inbound message resource (image/file) to ~/.tlive/inbox.
   *  NOTE: messageResource.get streaming path is doc-derived — untested live. */
  private async downloadToInbox(messageId: string, fileKey: string, type: 'image' | 'file', name: string): Promise<string> {
    if (!this.client) throw new Error('feishu not connected');
    const res = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    const inbox = join(process.env.TLIVE_HOME ?? join(homedir(), '.tlive'), 'inbox');
    mkdirSync(inbox, { recursive: true });
    const dest = join(inbox, `${randomUUID().slice(0, 8)}-${basename(name)}`);
    // lark SDK responses expose writeFile for binary payloads
    await (res as unknown as { writeFile: (p: string) => Promise<void> }).writeFile(dest);
    return dest;
  }

  async start(): Promise<void> {
    if (this.connected === 'connected') return;
    this.client = new Client({ appId: this.opts.appId, appSecret: this.opts.appSecret });
    this.ws = new WSClient({ appId: this.opts.appId, appSecret: this.opts.appSecret });
    const dispatcher = new EventDispatcher({});
    dispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        if (!this.inboundHandler) return;
        const d = data as { event: { sender: { sender_id: { user_id: string } }; message: { message_id: string; chat_id: string; content: string; create_time: string; message_type?: string; parent_id?: string; root_id?: string } } };
        const ev = d.event;
        // Fail-closed: only forward inbound from the configured chat.
        if (!this.opts.chatId || ev.message.chat_id !== this.opts.chatId) return;
        // content is JSON: text → {"text"}; image → {"image_key"}; file → {"file_key","file_name"}
        let text = '';
        let attachments: IncomingEnvelope['attachments'];
        try {
          const c = JSON.parse(ev.message.content) as { text?: string; image_key?: string; file_key?: string; file_name?: string };
          text = c.text ?? '';
          const key = c.image_key ?? c.file_key;
          if (key) {
            const isImage = !!c.image_key;
            const name = c.file_name ?? (isImage ? `image-${key.slice(-8)}.png` : 'file');
            try {
              const localPath = await this.downloadToInbox(ev.message.message_id, key, isImage ? 'image' : 'file', name);
              attachments = [{ name, mime: isImage ? 'image/png' : 'application/octet-stream', localPath, sizeBytes: 0 }];
            } catch { /* skip failed downloads */ }
          }
        } catch { /* not JSON */ }
        // parent_id = the message this one replies to (Feishu "回复"); root_id as fallback.
        const replyTo = ev.message.parent_id ?? ev.message.root_id;
        this.inboundHandler({
          channel: 'feishu',
          chatId: ev.message.chat_id,
          userId: ev.sender.sender_id.user_id,
          messageId: ev.message.message_id,
          text,
          ...(attachments ? { attachments } : {}),
          ...(replyTo ? { replyToMessageId: replyTo } : {}),
          ts: Number(ev.message.create_time) || Date.now(),
        });
      },
      // Card button taps → synthesize envelope with text = button id ("approve:<id>"/"deny:<id>").
      'card.action.trigger': async (data: unknown) => {
        const d = data as { event?: { operator?: { user_id?: string; open_id?: string }; action?: { value?: { tlive?: string } }; context?: { open_chat_id?: string; open_message_id?: string } } };
        const chatId = d.event?.context?.open_chat_id ?? '';
        // Fail-closed: only forward callbacks from the configured chat.
        if (!this.opts.chatId || chatId !== this.opts.chatId) return;
        const val = d.event?.action?.value?.tlive;
        if (val && this.inboundHandler) {
          this.inboundHandler({
            channel: 'feishu',
            chatId,
            userId: d.event?.operator?.user_id ?? d.event?.operator?.open_id ?? '',
            messageId: d.event?.context?.open_message_id ?? '',
            text: val,
            ts: Date.now(),
          });
        }
        // Acknowledge so the card stops spinning.
        return { toast: { type: 'success', content: 'Received' } };
      },
    });
    await this.ws.start({ eventDispatcher: dispatcher });
    this.connected = 'connected';
  }

  async stop(): Promise<void> {
    if (!this.ws) { this.connected = 'idle'; return; }
    try { this.ws.close(); } catch {}
    this.ws = null;
    this.client = null;
    this.connected = 'idle';
  }

  async send(out: OutgoingMessage): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('feishu not connected');
    if (!this.opts.chatId) throw new Error('feishu chatId not configured');
    const data = out.kind === 'card'
      ? { receive_id: this.opts.chatId, msg_type: 'interactive', content: JSON.stringify(buildCard(out)) }
      : { receive_id: this.opts.chatId, msg_type: 'text', content: JSON.stringify({ text: out.text }) };
    const res = await this.client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data });
    return { messageId: (res as { data?: { message_id?: string } }).data?.message_id ?? '' };
  }

  async edit(messageId: string, out: OutgoingMessage): Promise<void> {
    if (!this.client) throw new Error('feishu not connected');
    const content = out.kind === 'card'
      ? JSON.stringify(buildCard(out))
      : JSON.stringify({ text: out.text });
    await this.client.im.v1.message.patch({ path: { message_id: messageId }, data: { content } });
  }

  onInbound(handler: (env: IncomingEnvelope) => void): void {
    this.inboundHandler = handler;
  }

  isConnected(): 'connected' | 'idle' | 'failed' { return this.connected; }
}
