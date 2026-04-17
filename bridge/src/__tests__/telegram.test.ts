import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimitError } from '../channels/errors.js';

// Mock grammy before importing
const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
const mockEditMessageText = vi.fn().mockResolvedValue({});
const mockSendChatAction = vi.fn().mockResolvedValue(true);
const mockSendPhoto = vi.fn().mockResolvedValue({ message_id: 42 });
const mockSendDocument = vi.fn().mockResolvedValue({ message_id: 42 });
const mockGetMe = vi.fn().mockResolvedValue({ id: 1, username: 'testbot', can_read_all_group_messages: true });
const mockSetMyCommands = vi.fn().mockResolvedValue(true);
const mockSetMessageReaction = vi.fn().mockResolvedValue(true);
const mockDeleteWebhook = vi.fn().mockResolvedValue(true);
const mockSetWebhook = vi.fn().mockResolvedValue(true);
const mockGetFile = vi.fn().mockResolvedValue({ file_path: 'photos/file.jpg' });
const mockOn = vi.fn();

vi.mock('grammy', () => {
  class MockBot {
    api = {
      sendMessage: mockSendMessage,
      editMessageText: mockEditMessageText,
      sendChatAction: mockSendChatAction,
      sendPhoto: mockSendPhoto,
      sendDocument: mockSendDocument,
      getMe: mockGetMe,
      setMyCommands: mockSetMyCommands,
      setMessageReaction: mockSetMessageReaction,
      deleteWebhook: mockDeleteWebhook,
      setWebhook: mockSetWebhook,
      getFile: mockGetFile,
      config: { use: vi.fn() },
    };
    on = mockOn;
    handleUpdate = vi.fn();
  }
  class InputFile {
    constructor(public data: any, public filename?: string) {}
  }
  return { Bot: MockBot, InputFile };
});

vi.mock('@grammyjs/runner', () => ({
  run: vi.fn().mockReturnValue({ stop: vi.fn() }),
}));

vi.mock('@grammyjs/transformer-throttler', () => ({
  apiThrottler: vi.fn().mockReturnValue(vi.fn()),
}));

import { TelegramAdapter } from '../channels/telegram.js';

describe('TelegramAdapter', () => {
  const defaultConfig = {
    botToken: 'test-token',
    chatId: '12345',
    allowedUsers: ['user1', 'user2'],
    requireMention: true,
    webhookUrl: '',
    webhookSecret: '',
    webhookPort: 8443,
    disableLinkPreview: true,
    proxy: '',
  };
  let adapter: TelegramAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new TelegramAdapter(defaultConfig);
  });

  it('has correct channel type', () => {
    expect(adapter.channelType).toBe('telegram');
  });

  it('validates config — requires botToken', () => {
    const bad = new TelegramAdapter({ ...defaultConfig, botToken: '' });
    expect(bad.validateConfig()).toContain('TL_TG_BOT_TOKEN');
  });

  it('validates config — passes with token', () => {
    expect(adapter.validateConfig()).toBeNull();
  });

  it('authorizes allowed users', () => {
    expect(adapter.isAuthorized('user1', '12345')).toBe(true);
    expect(adapter.isAuthorized('unknown', '12345')).toBe(false);
  });

  it('pairing mode: denies unknown users when allowedUsers is empty', () => {
    const pairingAdapter = new TelegramAdapter({ ...defaultConfig, allowedUsers: [] });
    expect(pairingAdapter.isAuthorized('anyone', 'anychat')).toBe(false);
  });

  it('pairing mode: approves user after pairing', () => {
    const pairingAdapter = new TelegramAdapter({ ...defaultConfig, allowedUsers: [] });
    expect(pairingAdapter.isAuthorized('u1', 'c1')).toBe(false);
    const code = pairingAdapter.requestPairing('u1', 'c1', 'testuser');
    expect(code).toBeTruthy();
    expect(code).toHaveLength(6);
    expect(pairingAdapter.isAuthorized('u1', 'c1')).toBe(false);
    const result = pairingAdapter.approvePairing(code!);
    expect(result).toEqual({ userId: 'u1', username: 'testuser' });
    expect(pairingAdapter.isAuthorized('u1', 'c1')).toBe(true);
  });

  it('pairing: returns same code for same user', () => {
    const pairingAdapter = new TelegramAdapter({ ...defaultConfig, allowedUsers: [] });
    const code1 = pairingAdapter.requestPairing('u1', 'c1', 'user');
    const code2 = pairingAdapter.requestPairing('u1', 'c1', 'user');
    expect(code1).toBe(code2);
  });

  it('pairing: invalid code returns null', () => {
    const pairingAdapter = new TelegramAdapter({ ...defaultConfig, allowedUsers: [] });
    expect(pairingAdapter.approvePairing('000000')).toBeNull();
  });

  it('sends message via grammY api', async () => {
    await adapter.start();
    const result = await adapter.send({ chatId: '12345', html: '<b>hello</b>' });
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('42');
    expect(mockSendMessage).toHaveBeenCalledWith(
      '12345', '<b>hello</b>',
      expect.objectContaining({ parse_mode: 'HTML' })
    );
  });

  it('sends message with buttons as inline keyboard', async () => {
    await adapter.start();
    const result = await adapter.send({
      chatId: '12345',
      text: 'Choose:',
      buttons: [
        { label: 'Allow', callbackData: 'perm:allow:123' },
        { label: 'Deny', callbackData: 'perm:deny:123', style: 'danger' },
      ],
    });
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(
      '12345', 'Choose:',
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.any(Array),
        }),
      })
    );
  });

  it('disables link preview by default', async () => {
    await adapter.start();
    await adapter.send({ chatId: '12345', text: 'https://example.com' });
    expect(mockSendMessage).toHaveBeenCalledWith(
      '12345', 'https://example.com',
      expect.objectContaining({
        link_preview_options: { is_disabled: true },
      })
    );
  });

  describe('topic support', () => {
    it('passes message_thread_id when threadId is set', async () => {
      await adapter.start();
      await adapter.send({ chatId: '12345', text: 'topic message', threadId: '999' });
      expect(mockSendMessage).toHaveBeenCalledWith(
        '12345', 'topic message',
        expect.objectContaining({ message_thread_id: 999 })
      );
    });

    it('omits message_thread_id for General topic (1)', async () => {
      await adapter.start();
      await adapter.send({ chatId: '12345', text: 'general', threadId: '1' });
      expect(mockSendMessage).toHaveBeenCalledWith(
        '12345', 'general',
        expect.objectContaining({ message_thread_id: undefined })
      );
    });
  });

  describe('chunked send', () => {
    it('sends single message when under 4096 chars', async () => {
      await adapter.start();
      await adapter.send({ chatId: '12345', text: 'short' });
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it('splits long messages into multiple sends', async () => {
      await adapter.start();
      const longText = 'x\n'.repeat(3000);
      await adapter.send({ chatId: '12345', text: longText });
      expect(mockSendMessage.mock.calls.length).toBeGreaterThan(1);
    });

    it('adds multipart intro and labels to long messages', async () => {
      await adapter.start();
      const longText = ('## Heading\nBody line\n\n').repeat(400);
      await adapter.send({ chatId: '12345', text: longText });
      expect(mockSendMessage.mock.calls.length).toBeGreaterThan(1);
      expect(mockSendMessage.mock.calls[0][1]).toContain('Long reply — split into readable parts.');
      expect(mockSendMessage.mock.calls[0][1]).toContain('[1/');
    });
  });

  describe('editMessage', () => {
    it('calls editMessageText', async () => {
      await adapter.start();
      await adapter.editMessage('12345', '42', { chatId: '12345', text: 'updated' });
      expect(mockEditMessageText).toHaveBeenCalledWith('12345', 42, 'updated', expect.any(Object));
    });

    it('ignores "message is not modified" error', async () => {
      await adapter.start();
      mockEditMessageText.mockRejectedValueOnce(new Error('message is not modified'));
      await expect(
        adapter.editMessage('12345', '42', { chatId: '12345', text: 'same' })
      ).resolves.toBeUndefined();
    });
  });

  describe('sendTyping', () => {
    it('calls sendChatAction', async () => {
      await adapter.start();
      await adapter.sendTyping('12345');
      expect(mockSendChatAction).toHaveBeenCalledWith('12345', 'typing');
    });

    it('swallows errors', async () => {
      await adapter.start();
      mockSendChatAction.mockRejectedValueOnce(new Error('network'));
      await expect(adapter.sendTyping('12345')).resolves.toBeUndefined();
    });
  });

  describe('start()', () => {
    it('registers getMe and setMyCommands', async () => {
      await adapter.start();
      expect(mockGetMe).toHaveBeenCalled();
      expect(mockSetMyCommands).toHaveBeenCalled();
    });

    it('installs throttler', async () => {
      const { apiThrottler } = await import('@grammyjs/transformer-throttler');
      await adapter.start();
      expect(apiThrottler).toHaveBeenCalled();
    });

    it('starts runner for long-polling', async () => {
      const { run } = await import('@grammyjs/runner');
      await adapter.start();
      expect(run).toHaveBeenCalled();
    });
  });

  describe('reactions', () => {
    it('addReaction calls setMessageReaction', async () => {
      await adapter.start();
      await adapter.addReaction('12345', '42', '👍');
      expect(mockSetMessageReaction).toHaveBeenCalledWith('12345', 42, [{ type: 'emoji', emoji: '👍' }]);
    });

    it('removeReaction calls setMessageReaction with empty array', async () => {
      await adapter.start();
      await adapter.removeReaction('12345', '42');
      expect(mockSetMessageReaction).toHaveBeenCalledWith('12345', 42, []);
    });
  });

  describe('error handling', () => {
    it('wraps Telegram API errors into typed errors', async () => {
      await adapter.start();
      mockSendMessage.mockRejectedValueOnce({
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 5 },
      });
      await expect(adapter.send({ chatId: '12345', text: 'hi' }))
        .rejects.toBeDefined();
    });

    it('falls back to plain text on parse_mode 400 error', async () => {
      await adapter.start();
      mockSendMessage
        .mockRejectedValueOnce({ error_code: 400, description: 'Bad Request: can\'t parse' })
        .mockResolvedValueOnce({ message_id: 99 });
      const result = await adapter.send({ chatId: '12345', html: '<invalid>' });
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // Second call should not have parse_mode
      expect(mockSendMessage.mock.calls[1][2].parse_mode).toBeUndefined();
    });
  });
});
