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

/** Build a Feishu interactive card — JSON schema 2.0 (client 7.20+, older
 *  clients degrade to an upgrade prompt; doc-verified 2026-07-21). 2.0 buys:
 *  native inline code / `> ` quote / fences in markdown (feishu-card.ts is
 *  near-passthrough now), and strict validation (unknown attrs REJECT the
 *  send — keep this builder minimal). Buttons live directly in body.elements
 *  (2.0 shape), two per column_set row to mirror the TG layout. An
 *  `inputAction` renders a form with a multiline input + submit — the native
 *  "answer in your own words" box (V6.8+, works in 1.0 and 2.0).
 *  Header gets the `blue` template only while the card is actionable; an
 *  informational/settled card steps back to the calmer `wathet` (soft blue). */
export function buildCard(out: CardMessage): object {
  // Ask cards get a dedicated layout (terminal-style: bold question, options
  // with dim descriptions) instead of the generic numbered-list body — the
  // buttons already carry the labels, so the generic list read as duplication
  // (live feedback: "样式太丑,没有排版").
  const elements: object[] = out.ask ? askElements(out.ask) : [...mdToFeishuElements(out.body)];
  // The form submit replaces a same-id plain button (multi-select Submit):
  // one submit total — typed text and ticked boxes travel together.
  const buttons = out.inputAction ? out.buttons?.filter((b) => b.id !== out.inputAction!.id) : out.buttons;
  if (buttons?.length) {
    const btn = (b: { id: string; label: string }): object => ({
      tag: 'button',
      text: { tag: 'plain_text', content: b.label },
      type: buttonType(b.id),
      behaviors: [{ type: 'callback', value: { tlive: b.id } }],
    });
    // Two buttons per row via column_set — a flat stack of full-width buttons
    // reads like a wall for ask cards with many options.
    for (let i = 0; i < buttons.length; i += 2) {
      const pair = buttons.slice(i, i + 2);
      elements.push({
        tag: 'column_set',
        columns: pair.map((b) => ({
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [btn(b)],
        })),
      });
    }
  }
  if (out.inputAction) {
    elements.push({
      tag: 'form',
      name: 'tlive_form',
      elements: [
        {
          tag: 'input',
          name: 'reply',
          required: true,
          input_type: 'multiline_text',
          placeholder: { tag: 'plain_text', content: out.inputAction.placeholder },
        },
        {
          tag: 'button',
          // 2.0 shape, probed live 2026-07-21: 1.0's action_type:'form_submit'
          // is REJECTED (300123 "no submit button in the form container");
          // form_action_type:'submit' sends + patches clean.
          form_action_type: 'submit',
          name: 'send',
          text: { tag: 'plain_text', content: out.inputAction.submitLabel },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { tlive: out.inputAction.id } }],
        },
      ],
    });
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    ...(out.title
      ? {
          header: {
            title: { tag: 'plain_text', content: out.title },
            // Header colour = the card's demand on you at a glance: blue when
            // it needs an action (approval / question buttons or a reply box),
            // the calmer wathet (soft blue) when it's just informational
            // (turn-finished, settled). An approval card going blue→wathet on
            // settlement still steps back — wathet is lighter and lifeless-grey
            // read badly (live feedback: "这个颜色不好看").
            template: buttons?.length || out.inputAction ? 'blue' : 'wathet',
          },
        }
      : {}),
    body: { elements },
  };
}

/** Terminal-style ask layout: bold question, options as "label — description"
 *  lines. No numbers for multi (the checkbox buttons carry the labels);
 *  numbered for single so the "1. label" buttons have an anchor. */
function askElements(ask: NonNullable<CardMessage extends { kind: 'card' } ? CardMessage['ask'] : never>): object[] {
  const els: object[] = [];
  els.push(...mdToFeishuElements(`**${ask.question}**`));
  const lines = ask.options.map((o, i) => {
    const label = ask.multiSelect ? `**${o.label}**` : `**${i + 1}. ${o.label}**`;
    return o.description ? `${label} — ${o.description}` : label;
  });
  els.push(...mdToFeishuElements(lines.join('\n')));
  return els;
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
        // The SDK's EventDispatcher.parse FLATTENS the payload before invoking
        // handlers: v2 events arrive as {...header, ...event} — `message` and
        // `sender` live at the TOP level, there is no `.event` wrapper (lib
        // requestHandle.parse; the wrapped read crashed every inbound text with
        // "Cannot read properties of undefined (reading 'message')" — feishu
        // inbound had never actually worked). Tolerate both shapes anyway.
        type FeishuMsgEvent = { sender: { sender_id: { user_id: string } }; message: { message_id: string; chat_id: string; content: string; create_time: string; message_type?: string; parent_id?: string; root_id?: string } };
        const raw = data as FeishuMsgEvent & { event?: FeishuMsgEvent };
        const ev = raw.message ? raw : raw.event;
        if (!ev?.message) return;
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
        // Same flattening as above — operator/action/context sit at the top
        // level (the `.event` read was a silent no-op thanks to `?.`, so card
        // buttons never worked either). Tolerate both shapes.
        type FeishuCardEvent = { operator?: { user_id?: string; open_id?: string }; action?: { value?: { tlive?: string }; form_value?: Record<string, unknown>; input_value?: unknown }; context?: { open_chat_id?: string; open_message_id?: string } };
        const raw = data as FeishuCardEvent & { event?: FeishuCardEvent };
        const d = raw.action || raw.context ? raw : (raw.event ?? {});
        const chatId = d.context?.open_chat_id ?? '';
        // Fail-closed: only forward callbacks from the configured chat.
        if (!this.opts.chatId || chatId !== this.opts.chatId) return;
        const val = d.action?.value?.tlive;
        // Form submit → typed text arrives as form_value {name: value};
        // standalone input → input_value. Either way it rides as formText.
        const act = d.action as { form_value?: Record<string, unknown>; input_value?: unknown } | undefined;
        const typedRaw = act?.form_value ? act.form_value['reply'] : act?.input_value;
        const typed = typeof typedRaw === 'string' && typedRaw.trim() ? typedRaw : undefined;
        if (val && this.inboundHandler) {
          this.inboundHandler({
            channel: 'feishu',
            chatId,
            userId: d.operator?.user_id ?? d.operator?.open_id ?? '',
            messageId: d.context?.open_message_id ?? '',
            text: val,
            ...(typed ? { formText: typed } : {}),
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
