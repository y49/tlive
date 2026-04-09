import type { ChannelType, InboundMessage, OutboundMessage, SendResult } from './types.js';
import type { RenderedMessage } from '../renderers/types.js';

export abstract class BaseChannelAdapter<T extends RenderedMessage = RenderedMessage> {
  abstract readonly channelType: ChannelType;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract consumeOne(): Promise<InboundMessage | null>;
  abstract send(message: OutboundMessage): Promise<SendResult>;
  abstract editMessage(chatId: string, messageId: string, message: OutboundMessage): Promise<void>;
  abstract sendTyping(chatId: string): Promise<void>;
  abstract validateConfig(): string | null;
  abstract isAuthorized(userId: string, chatId: string): boolean;

  // Typed methods for rendered messages (Phase C: coexist with legacy send/editMessage)
  abstract sendRendered(chatId: string, message: T): Promise<SendResult>;
  abstract editRendered(chatId: string, messageId: string, message: T): Promise<void>;

  /** Delete a message. Override in adapters that support deletion. */
  async deleteMessage(_chatId: string, _messageId: string): Promise<void> {}

  /** Add a reaction emoji to a message. Override in adapters that support reactions. */
  async addReaction(_chatId: string, _messageId: string, _emoji: string): Promise<void> {}

  /** Remove all bot reactions from a message. */
  async removeReaction(_chatId: string, _messageId: string): Promise<void> {}
}

const factories = new Map<ChannelType, () => BaseChannelAdapter>();

export function registerAdapterFactory(type: ChannelType, factory: () => BaseChannelAdapter): void {
  factories.set(type, factory);
}

export function createAdapter(type: ChannelType): BaseChannelAdapter {
  const factory = factories.get(type);
  if (!factory) throw new Error(`Unknown channel type: ${type}`);
  return factory();
}

export function getRegisteredTypes(): ChannelType[] {
  return Array.from(factories.keys());
}
