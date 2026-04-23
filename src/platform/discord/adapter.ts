// src/platform/discord/adapter.ts
//
// PlatformAdapter for Discord, powered by discord.js. Uses the Gateway
// WebSocket via `client.login(token)`. Inbound messages + interactions are
// translated into our platform-agnostic InboundEvent.
//
// Not supported without a Guild context:
//   - pin() requires ManageMessages permission on the channel.
//   - setReaction() → addReaction/removeReaction on the message.
//
// Elicitation forms are presented through Modal components, but a Modal can
// only be shown in response to an interaction. The adapter exposes
// `pendingModals` so a command handler can attach a Modal to its interaction
// reply path.

import { Client, GatewayIntentBits, type Message, type BaseChannel, type TextBasedChannel } from 'discord.js';
import type {
  PlatformAdapter, OutboundMessage, OutboundAttachment, InboundEvent, ReplyMarkup,
} from '../types.js';
import type { ChannelType } from '../../workspace/bindings.js';
import { replyMarkupToDiscord } from './renderer.js';
import { sendDiscordAttachment, downloadDiscordAttachment } from './attachment.js';

export interface DiscordAdapterOptions {
  token: string;
  /** Inject a pre-built Client for tests. */
  client?: Client;
  /** Skip login (tests drive events directly). */
  skipLogin?: boolean;
}

export class DiscordAdapter implements PlatformAdapter {
  readonly channelType: ChannelType = 'discord';
  private readonly client: Client;
  private readonly inboundListeners = new Set<(ev: InboundEvent) => void>();
  private readonly options: DiscordAdapterOptions;
  /** Pending modal specs keyed by interaction customId. Consumed by command handler. */
  readonly pendingModals = new Map<string, { title: string; fields: unknown[] }>();

  constructor(options: DiscordAdapterOptions) {
    this.options = options;
    this.client = options.client ?? new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
    this.wireHandlers();
  }

  async start(): Promise<void> {
    if (this.options.skipLogin) return;
    await this.client.login(this.options.token);
  }

  async stop(): Promise<void> {
    if (this.options.skipLogin) return;
    await this.client.destroy();
  }

  async send(msg: OutboundMessage): Promise<string> {
    const channel = await this.resolveChannel(msg.chatId, msg.threadId);
    const components = replyMarkupToDiscord(msg.replyMarkup);
    if (msg.attachment) {
      return sendDiscordAttachment({
        channel: channel as unknown as Parameters<typeof sendDiscordAttachment>[0]['channel'],
        attachment: { ...msg.attachment, caption: msg.text },
        components,
      });
    }
    const sent = await (channel as unknown as { send: (options: unknown) => Promise<Message> }).send({
      content: msg.text ?? '',
      components,
    });
    return sent.id;
  }

  async edit(messageId: string, chatId: string, text?: string, markup?: ReplyMarkup): Promise<void> {
    const channel = await this.resolveChannel(chatId);
    const message = await (channel as unknown as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(messageId);
    const components = replyMarkupToDiscord(markup);
    await message.edit({ content: text ?? message.content, components });
  }

  async delete(messageId: string, chatId: string): Promise<void> {
    const channel = await this.resolveChannel(chatId);
    const message = await (channel as unknown as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(messageId);
    await message.delete();
  }

  async pin(messageId: string, chatId: string): Promise<void> {
    const channel = await this.resolveChannel(chatId);
    const message = await (channel as unknown as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(messageId);
    await message.pin();
  }

  async setReaction(messageId: string, chatId: string, emoji: string | null): Promise<void> {
    const channel = await this.resolveChannel(chatId);
    const message = await (channel as unknown as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(messageId);
    if (emoji === null) {
      await message.reactions.removeAll();
      return;
    }
    await message.react(emoji);
  }

  async sendAttachment(
    chatId: string,
    attachment: OutboundAttachment | undefined,
    replyMarkup?: ReplyMarkup,
    threadId?: string,
  ): Promise<string> {
    if (!attachment) throw new Error('DiscordAdapter.sendAttachment: attachment required');
    const channel = await this.resolveChannel(chatId, threadId);
    const components = replyMarkupToDiscord(replyMarkup);
    return sendDiscordAttachment({
      channel: channel as unknown as Parameters<typeof sendDiscordAttachment>[0]['channel'],
      attachment,
      caption: attachment.caption,
      components,
    });
  }

  async downloadAttachment(fileRef: string): Promise<Buffer> {
    return downloadDiscordAttachment(fileRef);
  }

  onInbound(cb: (ev: InboundEvent) => void): () => void {
    this.inboundListeners.add(cb);
    return () => this.inboundListeners.delete(cb);
  }

  // ---- Internals ----------------------------------------------------------

  private async resolveChannel(chatId: string, threadId?: string): Promise<TextBasedChannel | BaseChannel> {
    const id = threadId ?? chatId;
    const channel = this.client.channels.cache.get(id) ?? await this.client.channels.fetch(id);
    if (!channel) throw new Error(`DiscordAdapter: channel ${id} not found`);
    return channel as TextBasedChannel;
  }

  private wireHandlers(): void {
    this.client.on('messageCreate', (msg) => {
      if (msg.author.bot) return;
      const ev: InboundEvent = {
        channelType: 'discord',
        chatId: msg.channelId,
        threadId: msg.channel.isThread() ? msg.channelId : undefined,
        messageId: msg.id,
        userId: msg.author.id,
        username: msg.author.username,
        text: msg.content,
        attachments: msg.attachments.size > 0
          ? [...msg.attachments.values()].map((a) => ({
            name: a.name ?? 'file',
            mime: a.contentType ?? 'application/octet-stream',
            fileRef: a.url,
            sizeBytes: a.size,
          }))
          : undefined,
        replyToMessageId: msg.reference?.messageId ?? undefined,
        kind: msg.attachments.size > 0 ? 'attachment' : 'message',
        at: msg.createdTimestamp,
      };
      this.emitInbound(ev);
    });

    this.client.on('interactionCreate', (interaction) => {
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const ev: InboundEvent = {
          channelType: 'discord',
          chatId: interaction.channelId ?? '',
          threadId: interaction.channel?.isThread() ? interaction.channelId ?? undefined : undefined,
          messageId: interaction.message.id,
          userId: interaction.user.id,
          username: interaction.user.username,
          callbackData: interaction.customId,
          kind: 'callback',
          at: Date.now(),
        };
        this.emitInbound(ev);
        void interaction.deferUpdate().catch(() => { /* isolate */ });
      } else if (interaction.isModalSubmit()) {
        const values: Record<string, string> = {};
        for (const [key, field] of interaction.fields.fields) {
          values[key] = (field as unknown as { value: string }).value;
        }
        const ev: InboundEvent = {
          channelType: 'discord',
          chatId: interaction.channelId ?? '',
          messageId: interaction.id,
          userId: interaction.user.id,
          username: interaction.user.username,
          callbackData: interaction.customId,
          formValues: values,
          kind: 'form_submit',
          at: Date.now(),
        };
        this.emitInbound(ev);
        void interaction.deferReply({ ephemeral: true }).catch(() => { /* isolate */ });
      }
    });
  }

  private emitInbound(ev: InboundEvent): void {
    for (const l of this.inboundListeners) {
      try { l(ev); } catch { /* isolate */ }
    }
  }
}
