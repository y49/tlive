// tests/im/fake-adapter.ts
//
// In-memory PlatformAdapter used by renderer + frontend tests. Records every
// outbound call so assertions can inspect the exact sequence the renderer
// produced.

import type {
  PlatformAdapter, OutboundMessage, OutboundAttachment, InboundEvent, ParseMode, ReplyMarkup,
} from '../../src/platform/types.js';
import type { ChannelType } from '../../src/workspace/bindings.js';

export interface FakeCall {
  kind: 'send' | 'edit' | 'delete' | 'pin' | 'setReaction' | 'sendAttachment' | 'sendCard' | 'updateCard';
  at: number;
  args: Record<string, unknown>;
  returnedId?: string;
}

export class FakeAdapter implements PlatformAdapter {
  readonly calls: FakeCall[] = [];
  readonly inboundListeners = new Set<(ev: InboundEvent) => void>();
  private counter = 0;

  constructor(readonly channelType: ChannelType = 'telegram') {}

  private nextId(): string { return `m-${++this.counter}`; }

  async start(): Promise<void> { /* no-op */ }
  async stop(): Promise<void> { /* no-op */ }

  async send(msg: OutboundMessage): Promise<string> {
    const id = this.nextId();
    this.calls.push({
      kind: 'send',
      at: Date.now(),
      args: { ...msg },
      returnedId: id,
    });
    return id;
  }

  async edit(
    messageId: string, chatId: string, text?: string, markup?: ReplyMarkup, parseMode?: ParseMode,
  ): Promise<void> {
    this.calls.push({
      kind: 'edit',
      at: Date.now(),
      args: { messageId, chatId, text, markup, parseMode },
    });
  }

  async delete(messageId: string, chatId: string): Promise<void> {
    this.calls.push({ kind: 'delete', at: Date.now(), args: { messageId, chatId } });
  }

  async pin(messageId: string, chatId: string): Promise<void> {
    this.calls.push({ kind: 'pin', at: Date.now(), args: { messageId, chatId } });
  }

  async setReaction(messageId: string, chatId: string, emoji: string | null): Promise<void> {
    this.calls.push({ kind: 'setReaction', at: Date.now(), args: { messageId, chatId, emoji } });
  }

  async sendAttachment(
    chatId: string,
    attachment: OutboundAttachment | undefined,
    replyMarkup?: ReplyMarkup,
    threadId?: string,
  ): Promise<string> {
    const id = this.nextId();
    this.calls.push({
      kind: 'sendAttachment',
      at: Date.now(),
      args: { chatId, attachment, replyMarkup, threadId },
      returnedId: id,
    });
    return id;
  }

  sendCard = async (opts: { chatId: string; threadId?: string; card: object }): Promise<string> => {
    const id = this.nextId();
    this.calls.push({
      kind: 'sendCard',
      at: Date.now(),
      args: { ...opts },
      returnedId: id,
    });
    return id;
  };

  updateCard = async (messageId: string, chatId: string, card: object): Promise<void> => {
    this.calls.push({
      kind: 'updateCard',
      at: Date.now(),
      args: { messageId, chatId, card },
    });
  };

  async downloadAttachment(_fileRef: string): Promise<Buffer> {
    return Buffer.from('fake');
  }

  onInbound(cb: (ev: InboundEvent) => void): () => void {
    this.inboundListeners.add(cb);
    return () => this.inboundListeners.delete(cb);
  }

  emit(ev: InboundEvent): void {
    for (const l of this.inboundListeners) l(ev);
  }

  byKind(kind: FakeCall['kind']): FakeCall[] {
    return this.calls.filter((c) => c.kind === kind);
  }
}
