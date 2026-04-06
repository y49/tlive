import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType as DChannelType,
  type TextChannel,
  type ThreadChannel,
  type Message,
} from 'discord.js';
import { BaseChannelAdapter, registerAdapterFactory } from './base.js';
import type { InboundMessage, OutboundMessage, SendResult, FileAttachment } from './types.js';
import { loadConfig } from '../config.js';
import { chunkMarkdown } from '../delivery/delivery.js';
import { classifyError } from './errors.js';
import { createUndiciAgent, maskProxyUrl } from '../proxy.js';

interface DiscordConfig {
  botToken: string;
  allowedUsers: string[];
  allowedChannels: string[];
  proxy: string;
}

export class DiscordAdapter extends BaseChannelAdapter {
  readonly channelType = 'discord' as const;
  private client: Client | null = null;
  private config: DiscordConfig;
  private messageQueue: InboundMessage[] = [];

  constructor(config: DiscordConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    const agent = createUndiciAgent(this.config.proxy);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      rest: agent ? { agent } : {},
    });

    if (this.config.proxy) {
      console.log(`[discord] Using proxy for REST API: ${maskProxyUrl(this.config.proxy)}`);
      console.log('[discord] Note: Gateway WebSocket is not proxied (discord.js limitation). Use system-level proxy (e.g., Clash TUN) for full proxy support.');
    }

    this.client.on('messageCreate', async (msg) => {
      if (msg.author.bot) return;

      const attachments: FileAttachment[] = [];
      for (const [, att] of msg.attachments) {
        if ((att.size ?? 0) > 10_000_000) continue;
        try {
          const resp = await fetch(att.url);
          if (!resp.ok) continue;
          const buf = Buffer.from(await resp.arrayBuffer());
          const mimeType = att.contentType ?? 'application/octet-stream';
          attachments.push({
            type: mimeType.startsWith('image/') ? 'image' : 'file',
            name: att.name ?? 'file',
            mimeType, base64Data: buf.toString('base64'),
          });
        } catch { /* skip undownloadable attachments */ }
      }

      // If message is in a thread, record the thread ID and use parent channel as chatId
      const isThread = msg.channel.isThread();
      this.messageQueue.push({
        channelType: 'discord',
        chatId: isThread ? (msg.channel as ThreadChannel).parentId ?? msg.channelId : msg.channelId,
        userId: msg.author.id,
        text: msg.content,
        messageId: msg.id,
        replyToMessageId: msg.reference?.messageId ?? undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        threadId: isThread ? msg.channelId : undefined,
      });
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isButton()) return;
      await interaction.deferUpdate();
      this.messageQueue.push({
        channelType: 'discord',
        chatId: interaction.channelId,
        userId: interaction.user.id,
        text: '',
        callbackData: interaction.customId,
        messageId: interaction.message.id,
      });
    });

    // Probe bot capabilities after login
    this.client.once('ready', () => {
      const user = this.client!.user;
      console.log(`[discord] Bot ready: ${user?.tag} (id: ${user?.id})`);

      // Check permissions in allowed channels
      for (const channelId of this.config.allowedChannels) {
        this.client!.channels.fetch(channelId).then(ch => {
          if (!ch || !ch.isTextBased()) {
            console.warn(`[discord] ⚠ Channel ${channelId} not found or not a text channel`);
            return;
          }
          const perms = (ch as TextChannel).permissionsFor?.(user!.id);
          if (!perms) return;
          const required = ['SendMessages', 'ViewChannel', 'ReadMessageHistory', 'AddReactions', 'CreatePublicThreads'] as const;
          const missing = required.filter(p => !perms.has(p as any));
          if (missing.length > 0) {
            console.warn(`[discord] ⚠ Missing permissions in #${(ch as TextChannel).name}: ${missing.join(', ')}`);
          }
        }).catch(() => {});
      }
    });

    await this.client.login(this.config.botToken);
  }

  async stop(): Promise<void> {
    await this.client?.destroy();
    this.client = null;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.messageQueue.shift() ?? null;
  }

  /** Create a thread from a message. Returns the thread channel ID. */
  async createThread(channelId: string, messageId: string, name: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      if (!channel?.threads) return null;
      const thread = await channel.threads.create({
        startMessage: messageId,
        name: name.slice(0, 100), // Discord thread name limit
        autoArchiveDuration: 1440, // 24h
      });
      return thread.id;
    } catch { return null; }
  }

  /** Resolve send target: thread if specified, otherwise channel */
  private async resolveChannel(message: OutboundMessage): Promise<TextChannel | ThreadChannel> {
    if (!this.client) throw new Error('Discord client not started');
    // If threadId specified, send to the thread directly
    const targetId = message.threadId ?? message.chatId;
    const channel = await this.client.channels.fetch(targetId);
    if (!channel || (!('send' in channel))) {
      throw new Error(`Channel ${targetId} not found or not a text channel`);
    }
    return channel as TextChannel | ThreadChannel;
  }

  /** Split buttons into ActionRows (Discord max 5 buttons per row) */
  private static buildButtonRows(buttons: NonNullable<OutboundMessage['buttons']>): ActionRowBuilder<ButtonBuilder>[] {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let current = new ActionRowBuilder<ButtonBuilder>();
    for (const btn of buttons) {
      if (current.components.length >= 5) {
        rows.push(current);
        current = new ActionRowBuilder<ButtonBuilder>();
      }
      const builder = new ButtonBuilder()
        .setLabel(btn.label)
        .setStyle(btn.style === 'danger' ? ButtonStyle.Danger : ButtonStyle.Primary);
      if (btn.url) {
        builder.setURL(btn.url).setStyle(ButtonStyle.Link);
      } else {
        builder.setCustomId(btn.callbackData);
      }
      current.addComponents(builder);
    }
    if (current.components.length > 0) rows.push(current);
    return rows;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const channel = await this.resolveChannel(message);

    // Media sending
    if (message.media) {
      try {
        const media = message.media;
        let buffer: Buffer;
        if (media.buffer) {
          buffer = media.buffer;
        } else if (media.url?.startsWith('data:')) {
          const base64 = media.url.split(',')[1];
          buffer = Buffer.from(base64, 'base64');
        } else if (media.url) {
          // URL-based: use AttachmentBuilder with URL
          const { AttachmentBuilder } = await import('discord.js');
          const attachment = new AttachmentBuilder(media.url, { name: media.filename || 'image.png' });
          const sent = await channel.send({ content: message.text || '', files: [attachment] }) as Message;
          return { messageId: sent.id, success: true };
        } else {
          throw new Error('No media source');
        }

        const { AttachmentBuilder } = await import('discord.js');
        const attachment = new AttachmentBuilder(buffer, { name: media.filename || 'image.png' });
        const sent = await channel.send({ content: message.text || '', files: [attachment] }) as Message;
        return { messageId: sent.id, success: true };
      } catch (err) {
        if (!message.text && !message.embed) throw classifyError('discord', err);
      }
    }

    // Embed-based messages (permission cards, notifications)
    if (message.embed) {
      const embed = new EmbedBuilder();
      if (message.embed.title) embed.setTitle(message.embed.title);
      if (message.embed.description) embed.setDescription(message.embed.description);
      if (message.embed.color !== undefined) embed.setColor(message.embed.color);
      if (message.embed.fields) {
        for (const f of message.embed.fields) embed.addFields(f);
      }
      if (message.embed.footer) embed.setFooter({ text: message.embed.footer });

      const payload: Record<string, unknown> = { embeds: [embed] };
      if (message.buttons?.length) {
        payload.components = DiscordAdapter.buildButtonRows(message.buttons);
      }

      try {
        const sent = await channel.send(payload as any) as Message;
        return { messageId: sent.id, success: true };
      } catch (err) {
        throw classifyError('discord', err);
      }
    }

    const content = message.text ?? message.html ?? '';
    const chunks = chunkMarkdown(content, 2000);

    let lastSent: Message | undefined;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const payload: Parameters<TextChannel['send']>[0] = { content: chunks[i] };

        // Reply reference on first chunk only
        if (i === 0 && message.replyToMessageId) {
          (payload as Record<string, unknown>).reply = { messageReference: message.replyToMessageId };
        }

        // Buttons on last chunk only
        if (i === chunks.length - 1 && message.buttons?.length) {
          payload.components = DiscordAdapter.buildButtonRows(message.buttons);
        }

        lastSent = await channel.send(payload) as Message;
      }
    } catch (err) {
      throw classifyError('discord', err);
    }

    return { messageId: lastSent?.id ?? '', success: true };
  }

  async editMessage(chatId: string, messageId: string, message: OutboundMessage): Promise<void> {
    if (!this.client) return;

    try {
      // Use threadId if available, otherwise chatId
      const targetId = message.threadId ?? chatId;
      const channel = await this.client.channels.fetch(targetId) as TextChannel;
      if (!channel || !channel.messages) return;

      const existing = await channel.messages.fetch(messageId);
      if (!existing) return;

      if (message.embed) {
        const embed = new EmbedBuilder();
        if (message.embed.title) embed.setTitle(message.embed.title);
        if (message.embed.description) embed.setDescription(message.embed.description);
        if (message.embed.color !== undefined) embed.setColor(message.embed.color);
        if (message.embed.fields) {
          for (const f of message.embed.fields) embed.addFields(f);
        }
        if (message.embed.footer) embed.setFooter({ text: message.embed.footer });
        await existing.edit({ embeds: [embed] });
        return;
      }

      const content = message.text ?? message.html ?? '';
      const truncated = content.length > 2000 ? content.slice(0, 2000) : content;

      const payload: Parameters<Message['edit']>[0] = { content: truncated };

      if (message.buttons?.length) {
        payload.components = DiscordAdapter.buildButtonRows(message.buttons);
      } else if (message.buttons) {
        payload.components = []; // clear existing buttons
      }

      await existing.edit(payload);
    } catch (err: unknown) {
      // Streaming edits are non-fatal: log and swallow so the bridge stays alive
      const classified = classifyError('discord', err);
      console.warn(`[discord] editMessage failed (${classified.constructor.name}): ${classified.message}`);
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      const channel = await this.client?.channels.fetch(chatId);
      if (channel?.isTextBased()) await (channel as TextChannel).sendTyping();
    } catch {
      // Non-critical; swallow errors
    }
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(chatId) as TextChannel;
      if (!channel?.messages) return;
      const msg = await channel.messages.fetch(messageId);
      await msg.react(emoji);
    } catch { /* non-fatal */ }
  }

  async removeReaction(chatId: string, messageId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(chatId) as TextChannel;
      if (!channel?.messages) return;
      const msg = await channel.messages.fetch(messageId);
      // Remove all bot reactions
      const botId = this.client.user?.id;
      if (!botId) return;
      for (const [, reaction] of msg.reactions.cache) {
        if (reaction.me) await reaction.users.remove(botId);
      }
    } catch { /* non-fatal */ }
  }

  validateConfig(): string | null {
    if (!this.config.botToken) return 'TL_DC_BOT_TOKEN is required for Discord';
    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const userAllowed =
      this.config.allowedUsers.length === 0 || this.config.allowedUsers.includes(userId);
    const channelAllowed =
      this.config.allowedChannels.length === 0 || this.config.allowedChannels.includes(chatId);
    return userAllowed && channelAllowed;
  }
}

// Self-register
registerAdapterFactory('discord', () => new DiscordAdapter(loadConfig().discord));
