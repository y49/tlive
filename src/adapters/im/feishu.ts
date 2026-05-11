// src/adapters/im/feishu.ts
//
// CRITICAL: WSClient holds a ref'd retry timer. stop() must call WSClient.close()
// AND null out our reference so GC can collect.

import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import type { IMAdapter, IncomingEnvelope, OutgoingMessage } from '../../kernel/contracts/im-adapter.js';

export interface FeishuAdapterOpts {
  appId: string;
  appSecret: string;
  /** chat ID to send to; for now require single chat. */
  chatId?: string;
}

export class FeishuAdapter implements IMAdapter {
  readonly channel = 'feishu' as const;
  private client: Client | null = null;
  private ws: WSClient | null = null;
  private inboundHandler?: (env: IncomingEnvelope) => void;
  private connected: 'connected' | 'idle' | 'failed' = 'idle';

  constructor(private opts: FeishuAdapterOpts) {}

  async start(): Promise<void> {
    if (this.connected === 'connected') return;
    this.client = new Client({ appId: this.opts.appId, appSecret: this.opts.appSecret });
    this.ws = new WSClient({ appId: this.opts.appId, appSecret: this.opts.appSecret });
    const dispatcher = new EventDispatcher({});
    dispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        if (!this.inboundHandler) return;
        const d = data as { event: { sender: { sender_id: { user_id: string } }; message: { message_id: string; chat_id: string; content: string; create_time: string } } };
        const ev = d.event;
        // content is JSON like {"text":"..."}
        let text = '';
        try { text = (JSON.parse(ev.message.content) as { text?: string }).text ?? ''; } catch {}
        this.inboundHandler({
          channel: 'feishu',
          chatId: ev.message.chat_id,
          userId: ev.sender.sender_id.user_id,
          messageId: ev.message.message_id,
          text,
          ts: Number(ev.message.create_time) || Date.now(),
        });
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
    const text = out.kind === 'text' ? out.text : `${out.title ?? ''}\n${out.body}`;
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: this.opts.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    return { messageId: (res as { data?: { message_id?: string } }).data?.message_id ?? '' };
  }

  async edit(messageId: string, out: OutgoingMessage): Promise<void> {
    if (!this.client) throw new Error('feishu not connected');
    const text = out.kind === 'text' ? out.text : `${out.title ?? ''}\n${out.body}`;
    await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text }) },
    });
  }

  onInbound(handler: (env: IncomingEnvelope) => void): void {
    this.inboundHandler = handler;
  }

  isConnected(): 'connected' | 'idle' | 'failed' { return this.connected; }
}
