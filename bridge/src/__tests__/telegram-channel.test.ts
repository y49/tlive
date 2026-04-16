import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock grammy before importing — matches the pattern in telegram.test.ts
const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
const mockGetChat = vi.fn();
const mockCreateForumTopic = vi.fn();
const mockGetMe = vi.fn().mockResolvedValue({ id: 1, username: 'testbot', can_read_all_group_messages: true });
const mockSetMyCommands = vi.fn().mockResolvedValue(true);
const mockDeleteWebhook = vi.fn().mockResolvedValue(true);
const mockOn = vi.fn();

vi.mock('grammy', () => {
  class MockBot {
    api = {
      sendMessage: mockSendMessage,
      getChat: mockGetChat,
      createForumTopic: mockCreateForumTopic,
      getMe: mockGetMe,
      setMyCommands: mockSetMyCommands,
      editMessageText: vi.fn().mockResolvedValue({}),
      sendChatAction: vi.fn().mockResolvedValue(true),
      setMessageReaction: vi.fn().mockResolvedValue(true),
      deleteWebhook: mockDeleteWebhook,
      setWebhook: vi.fn().mockResolvedValue(true),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file.jpg' }),
      config: { use: vi.fn() },
    };
    on = mockOn;
    handleUpdate = vi.fn();
  }
  return { Bot: MockBot };
});

vi.mock('@grammyjs/runner', () => ({
  run: vi.fn().mockReturnValue({ stop: vi.fn() }),
}));

vi.mock('@grammyjs/transformer-throttler', () => ({
  apiThrottler: vi.fn().mockReturnValue(vi.fn()),
}));

import { TelegramAdapter } from '../channels/telegram.js';

const defaultConfig = {
  botToken: 'test-token',
  chatId: '12345',
  allowedUsers: ['user1'],
  requireMention: false,
  webhookUrl: '',
  webhookSecret: '',
  webhookPort: 8443,
  disableLinkPreview: false,
  proxy: '',
};

describe('TelegramAdapter.createTopicIfNeeded', () => {
  let adapter: TelegramAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new TelegramAdapter(defaultConfig);
    await adapter.start();
  });

  it('creates a forum topic and returns its id when chat is a forum', async () => {
    mockGetChat.mockResolvedValueOnce({ id: 12345, is_forum: true });
    mockCreateForumTopic.mockResolvedValueOnce({ message_thread_id: 7, name: 'test-session' });

    const threadId = await adapter.createTopicIfNeeded('12345', 'test-session');

    expect(mockGetChat).toHaveBeenCalledWith('12345');
    expect(mockCreateForumTopic).toHaveBeenCalledWith('12345', 'test-session');
    expect(threadId).toBe('7');
  });

  it('returns undefined and does not create a topic when chat is not a forum', async () => {
    mockGetChat.mockResolvedValueOnce({ id: 12345, is_forum: false });

    const threadId = await adapter.createTopicIfNeeded('12345', 'test-session');

    expect(mockGetChat).toHaveBeenCalledWith('12345');
    expect(mockCreateForumTopic).not.toHaveBeenCalled();
    expect(threadId).toBeUndefined();
  });

  it('returns undefined and logs a warning when getChat throws', async () => {
    mockGetChat.mockRejectedValueOnce(new Error('chat not found'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const threadId = await adapter.createTopicIfNeeded('12345', 'test-session');

    expect(threadId).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('createTopic failed'));
    warnSpy.mockRestore();
  });
});

describe('TelegramAdapter.send with threadId', () => {
  let adapter: TelegramAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new TelegramAdapter(defaultConfig);
    await adapter.start();
  });

  it('sends to plain chatId string (backward compatible)', async () => {
    const result = await adapter.send('12345', { html: '<b>hello</b>' });
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(
      '12345', '<b>hello</b>',
      expect.not.objectContaining({ message_thread_id: expect.anything() })
    );
  });

  it('sends with message_thread_id when target has threadId', async () => {
    const result = await adapter.send({ chatId: '12345', threadId: '7' }, { html: 'in topic' });
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(
      '12345', 'in topic',
      expect.objectContaining({ message_thread_id: 7 })
    );
  });

  it('sends without message_thread_id when target has no threadId', async () => {
    const result = await adapter.send({ chatId: '12345' }, { html: 'no thread' });
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(
      '12345', 'no thread',
      expect.not.objectContaining({ message_thread_id: expect.anything() })
    );
  });

  it('passes threadId as integer (parseInt)', async () => {
    await adapter.send({ chatId: '12345', threadId: '42' }, { html: 'typed' });
    const opts = mockSendMessage.mock.calls[0][2];
    expect(typeof opts.message_thread_id).toBe('number');
    expect(opts.message_thread_id).toBe(42);
  });
});
