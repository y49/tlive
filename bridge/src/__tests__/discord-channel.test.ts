import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock discord.js before importing the adapter — mirrors discord.test.ts pattern
const mockSend = vi.fn().mockResolvedValue({ id: 'msg-99' });
const mockEdit = vi.fn().mockResolvedValue({});
const mockSendTyping = vi.fn().mockResolvedValue(undefined);
const mockFetchMessage = vi.fn().mockResolvedValue({
  id: 'msg-99',
  edit: mockEdit,
});
const mockThreadsCreate = vi.fn();
const mockFetchChannel = vi.fn();
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();

vi.mock('discord.js', () => {
  const MockClient = vi.fn(function (this: any) {
    this.on = mockOn;
    this.once = mockOn;
    this.login = mockLogin;
    this.destroy = mockDestroy;
    this.channels = { fetch: mockFetchChannel };
  });

  class MockButtonBuilder {
    private data: Record<string, unknown> = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(label: string) { this.data.label = label; return this; }
    setStyle(style: unknown) { this.data.style = style; return this; }
    setURL(url: string) { this.data.url = url; return this; }
  }

  class MockActionRowBuilder {
    components: unknown[] = [];
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

  const ButtonStyle = { Primary: 1, Danger: 4, Link: 5 };
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

const defaultConfig = {
  botToken: 'test-bot-token',
  allowedUsers: ['user1'],
  allowedChannels: ['channel1'],
  proxy: '',
};

// ─── createThreadIfNeeded ────────────────────────────────────────────────────

describe('DiscordAdapter.createThreadIfNeeded', () => {
  let adapter: DiscordAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new DiscordAdapter(defaultConfig);
    await adapter.start();
  });

  it('creates a thread when channel supports it and returns thread.id', async () => {
    mockThreadsCreate.mockResolvedValueOnce({ id: 'thread-42' });
    mockFetchChannel.mockResolvedValueOnce({
      isTextBased: () => true,
      guild: {
        members: {
          me: {
            id: 'bot-1',
          },
        },
      },
      permissionsFor: () => ({ has: (perm: string) => perm === 'CreatePublicThreads' }),
      threads: { create: mockThreadsCreate },
    });

    const threadId = await adapter.createThreadIfNeeded('channel1', 'my-session');

    expect(mockFetchChannel).toHaveBeenCalledWith('channel1');
    expect(mockThreadsCreate).toHaveBeenCalledWith({
      name: 'my-session',
      autoArchiveDuration: 1440,
      reason: 'tlive workspace thread',
    });
    expect(threadId).toBe('thread-42');
  });

  it('returns undefined when CreatePublicThreads permission is missing', async () => {
    mockFetchChannel.mockResolvedValueOnce({
      isTextBased: () => true,
      guild: {
        members: {
          me: { id: 'bot-1' },
        },
      },
      permissionsFor: () => ({ has: () => false }),
      threads: { create: mockThreadsCreate },
    });

    const threadId = await adapter.createThreadIfNeeded('channel1', 'my-session');

    expect(mockThreadsCreate).not.toHaveBeenCalled();
    expect(threadId).toBeUndefined();
  });

  it('returns undefined when channel is not text-based', async () => {
    mockFetchChannel.mockResolvedValueOnce({
      isTextBased: () => false,
    });

    const threadId = await adapter.createThreadIfNeeded('channel1', 'my-session');

    expect(mockThreadsCreate).not.toHaveBeenCalled();
    expect(threadId).toBeUndefined();
  });

  it('returns undefined and logs warning when threads.create throws', async () => {
    mockFetchChannel.mockResolvedValueOnce({
      isTextBased: () => true,
      guild: { members: { me: { id: 'bot-1' } } },
      permissionsFor: () => ({ has: () => true }),
      threads: { create: vi.fn().mockRejectedValueOnce(new Error('rate limited')) },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const threadId = await adapter.createThreadIfNeeded('channel1', 'my-session');

    expect(threadId).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('createThread failed'));
    warnSpy.mockRestore();
  });
});

// ─── send() with threadId routing ────────────────────────────────────────────

describe('DiscordAdapter.send with threadId', () => {
  let adapter: DiscordAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFetchChannel.mockResolvedValue({
      send: mockSend,
      messages: { fetch: mockFetchMessage },
      isTextBased: () => true,
      sendTyping: mockSendTyping,
    });
    adapter = new DiscordAdapter(defaultConfig);
    await adapter.start();
  });

  it('sends to plain chatId string (backward compatible)', async () => {
    const result = await adapter.send('channel1', {
      embed: { title: 'Hello', description: 'World' },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-99');
    expect(mockFetchChannel).toHaveBeenCalledWith('channel1');
    expect(mockSend).toHaveBeenCalled();
  });

  it('sends to thread when threadId is provided', async () => {
    const mockThreadSend = vi.fn().mockResolvedValue({ id: 'msg-in-thread' });
    // First call fetches the thread channel, second may not occur
    mockFetchChannel
      .mockResolvedValueOnce({
        send: mockThreadSend,
        isTextBased: () => true,
      });

    const result = await adapter.send({ chatId: 'channel1', threadId: 'thread-42' }, {
      embed: { title: 'In thread' },
    });

    expect(result.success).toBe(true);
    expect(mockFetchChannel).toHaveBeenCalledWith('thread-42');
    expect(mockThreadSend).toHaveBeenCalled();
  });

  it('falls back to chatId when threadId is absent in object target', async () => {
    const result = await adapter.send({ chatId: 'channel1' }, {
      embed: { description: 'no thread' },
    });

    expect(result.success).toBe(true);
    expect(mockFetchChannel).toHaveBeenCalledWith('channel1');
  });
});
