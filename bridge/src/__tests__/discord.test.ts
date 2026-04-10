import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock discord.js before importing the adapter
const mockSend = vi.fn().mockResolvedValue({ id: 'msg-99' });
const mockEdit = vi.fn().mockResolvedValue({});
const mockSendTyping = vi.fn().mockResolvedValue(undefined);
const mockFetchMessage = vi.fn().mockResolvedValue({
  id: 'msg-99',
  edit: mockEdit,
});
const mockFetchChannel = vi.fn().mockResolvedValue({
  send: mockSend,
  messages: { fetch: mockFetchMessage },
  isTextBased: () => true,
  sendTyping: mockSendTyping,
});
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();

vi.mock('discord.js', () => {
  const MockClient = vi.fn(function (this: any) {
    this.on = mockOn;
    this.once = mockOn; // 'ready' event uses once
    this.login = mockLogin;
    this.destroy = mockDestroy;
    this.channels = { fetch: mockFetchChannel };
  });

  class MockButtonBuilder {
    private data: Record<string, unknown> = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(label: string) { this.data.label = label; return this; }
    setStyle(style: unknown) { this.data.style = style; return this; }
  }

  class MockActionRowBuilder {
    private components: unknown[] = [];
    addComponents(...items: unknown[]) { this.components.push(...items); return this; }
  }

  class MockEmbedBuilder {
    private data: Record<string, unknown> = {};
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    addFields(f: unknown) { if (!this.data.fields) this.data.fields = []; (this.data.fields as unknown[]).push(f); return this; }
    setFooter(f: unknown) { this.data.footer = f; return this; }
  }

  const ButtonStyle = { Primary: 1, Danger: 4 };
  const GatewayIntentBits = { Guilds: 1, GuildMessages: 2, MessageContent: 4, GuildMessageReactions: 8 };
  const ChannelType = {};

  return {
    Client: MockClient,
    ButtonBuilder: MockButtonBuilder,
    ActionRowBuilder: MockActionRowBuilder,
    EmbedBuilder: MockEmbedBuilder,
    ButtonStyle,
    GatewayIntentBits,
    ChannelType,
  };
});

import { DiscordAdapter } from '../channels/discord.js';

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DiscordAdapter({
      botToken: 'test-bot-token',
      allowedUsers: ['user1', 'user2'],
      allowedChannels: ['channel1'],
      proxy: '',
    });
  });

  it('has correct channelType', () => {
    expect(adapter.channelType).toBe('discord');
  });

  describe('validateConfig()', () => {
    it('returns error when botToken is missing', () => {
      const bad = new DiscordAdapter({ botToken: '', allowedUsers: [], allowedChannels: [], proxy: '' });
      expect(bad.validateConfig()).toContain('TL_DC_BOT_TOKEN');
    });

    it('returns null when config is valid', () => {
      expect(adapter.validateConfig()).toBeNull();
    });
  });

  describe('isAuthorized()', () => {
    it('allows users in allowedUsers list', () => {
      expect(adapter.isAuthorized('user1', 'channel1')).toBe(true);
    });

    it('denies users not in allowedUsers list', () => {
      expect(adapter.isAuthorized('unknown', 'channel1')).toBe(false);
    });

    it('denies channels not in allowedChannels list', () => {
      expect(adapter.isAuthorized('user1', 'other-channel')).toBe(false);
    });

    it('allows all users when allowedUsers is empty', () => {
      const open = new DiscordAdapter({ botToken: 'tok', allowedUsers: [], allowedChannels: [], proxy: '' });
      expect(open.isAuthorized('anyone', 'anychannel')).toBe(true);
    });

    it('allows all channels when allowedChannels is empty', () => {
      const open = new DiscordAdapter({ botToken: 'tok', allowedUsers: ['u1'], allowedChannels: [], proxy: '' });
      expect(open.isAuthorized('u1', 'any-channel')).toBe(true);
    });

    it('denies if user passes but channel fails', () => {
      const a = new DiscordAdapter({ botToken: 'tok', allowedUsers: ['u1'], allowedChannels: ['c1'], proxy: '' });
      expect(a.isAuthorized('u1', 'c2')).toBe(false);
    });
  });

  describe('send()', () => {
    it('sends embed-based message via channel.send', async () => {
      await adapter.start();
      const result = await adapter.send('channel1', {
        embed: { title: 'Test', description: 'Hello', color: 0xFF0000 },
      });
      expect(mockFetchChannel).toHaveBeenCalledWith('channel1');
      expect(mockSend).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-99');
    });

    it('sends message with button components', async () => {
      await adapter.start();
      await adapter.send('channel1', {
        embed: { title: 'Choose' },
        buttons: [
          { label: 'Allow', callbackData: 'perm:allow:123', style: 'primary' as const },
          { label: 'Deny', callbackData: 'perm:deny:123', style: 'danger' as const },
        ],
      });
      const call = mockSend.mock.calls[0][0];
      expect(call.components).toHaveLength(1);
    });
  });

  describe('editMessage()', () => {
    it('fetches then edits the message with embed', async () => {
      await adapter.start();
      await adapter.editMessage('channel1', 'msg-99', {
        embed: { title: 'Updated', description: 'New content' },
      });
      expect(mockFetchChannel).toHaveBeenCalledWith('channel1');
      expect(mockFetchMessage).toHaveBeenCalledWith('msg-99');
      expect(mockEdit).toHaveBeenCalled();
    });
  });

  describe('start() / stop()', () => {
    it('calls client.login on start', async () => {
      await adapter.start();
      expect(mockLogin).toHaveBeenCalledWith('test-bot-token');
    });

    it('calls client.destroy on stop', async () => {
      await adapter.start();
      await adapter.stop();
      expect(mockDestroy).toHaveBeenCalled();
    });
  });

  describe('consumeOne()', () => {
    it('returns null when queue is empty', async () => {
      const msg = await adapter.consumeOne();
      expect(msg).toBeNull();
    });
  });

  describe('sendTyping()', () => {
    it('calls channel.sendTyping', async () => {
      await adapter.start();
      await adapter.sendTyping('channel1');
      expect(mockFetchChannel).toHaveBeenCalledWith('channel1');
      expect(mockSendTyping).toHaveBeenCalled();
    });

    it('swallows errors', async () => {
      await adapter.start();
      mockFetchChannel.mockRejectedValueOnce(new Error('network'));
      await expect(adapter.sendTyping('channel1')).resolves.toBeUndefined();
    });
  });

  describe('addReaction()', () => {
    it('reacts to a message', async () => {
      const mockReact = vi.fn().mockResolvedValue(undefined);
      mockFetchMessage.mockResolvedValueOnce({ id: 'msg-99', react: mockReact });
      await adapter.start();
      await adapter.addReaction('channel1', 'msg-99', '👍');
      expect(mockReact).toHaveBeenCalledWith('👍');
    });

    it('swallows errors', async () => {
      mockFetchChannel.mockRejectedValueOnce(new Error('fail'));
      await adapter.start();
      await expect(adapter.addReaction('channel1', 'msg-99', '👍')).resolves.toBeUndefined();
    });
  });

  describe('removeReaction()', () => {
    it('swallows errors when client not started', async () => {
      await expect(adapter.removeReaction('channel1', 'msg-99')).resolves.toBeUndefined();
    });
  });

  describe('start() registers ready listener for permission probing', () => {
    it('registers once handler for ready event', async () => {
      await adapter.start();
      expect(mockOn).toHaveBeenCalledWith('ready', expect.any(Function));
    });
  });
});
