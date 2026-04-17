import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @larksuiteoapi/node-sdk before importing the adapter
const mockMessageCreate = vi.fn();
const mockMessagePatch = vi.fn().mockResolvedValue({});
const eventHandlers = new Map<string, (...args: any[]) => any>();
const mockEventHandler = vi.fn(async (event: any) => {
  const handler = eventHandlers.get('im.message.receive_v1');
  if (handler) await handler(event);
});
const mockWsStart = vi.fn().mockResolvedValue(undefined);

vi.mock('@larksuiteoapi/node-sdk', () => {
  const MockClient = vi.fn(function (this: any) {
    this.im = {
      message: {
        create: mockMessageCreate,
        patch: mockMessagePatch,
      },
      v1: { messageResource: { get: vi.fn().mockResolvedValue({ data: null }) } },
      image: { get: vi.fn().mockResolvedValue(null) },
      messageResource: { get: vi.fn().mockResolvedValue(null) },
    };
  });

  const MockEventDispatcher = vi.fn(function (this: any) {
    this.register = vi.fn((handlers: Record<string, (...args: any[]) => any>) => {
      for (const [key, fn] of Object.entries(handlers)) {
        eventHandlers.set(key, fn);
      }
    });
    this.invoke = vi.fn(async (body: string) => {
      const parsed = JSON.parse(body);
      if (parsed.type === 'url_verification') {
        return { challenge: parsed.challenge };
      }
      if (parsed.event) {
        await mockEventHandler(parsed.event);
      }
      return {};
    });
  });

  const MockWSClient = vi.fn(function (this: any) {
    this.close = vi.fn();
    this.start = mockWsStart;
  });

  return {
    Client: MockClient,
    EventDispatcher: MockEventDispatcher,
    WSClient: MockWSClient,
  };
});

import { FeishuAdapter } from '../channels/feishu.js';

describe('FeishuAdapter', () => {
  let adapter: FeishuAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageCreate.mockResolvedValue({ data: { message_id: 'msg-feishu-1' } });
    mockMessagePatch.mockResolvedValue({});
    adapter = new FeishuAdapter({
      appId: 'cli_test123',
      appSecret: 'secret_abc',
      verificationToken: 'verify_token',
      encryptKey: '',
      webhookPort: 0,
      allowedUsers: ['user1', 'user2'],
    });
  });

  it('has correct channelType', () => {
    expect(adapter.channelType).toBe('feishu');
  });

  describe('validateConfig()', () => {
    it('returns error when appId is missing', () => {
      const bad = new FeishuAdapter({ appId: '', appSecret: 'sec', verificationToken: '', encryptKey: '', webhookPort: 0, allowedUsers: [] });
      expect(bad.validateConfig()).toContain('TL_FS_APP_ID');
    });

    it('returns error when appSecret is missing', () => {
      const bad = new FeishuAdapter({ appId: 'id', appSecret: '', verificationToken: '', encryptKey: '', webhookPort: 0, allowedUsers: [] });
      expect(bad.validateConfig()).toContain('TL_FS_APP_SECRET');
    });

    it('returns null when config is valid', () => {
      expect(adapter.validateConfig()).toBeNull();
    });
  });

  describe('isAuthorized()', () => {
    it('allows users in allowedUsers list', () => {
      expect(adapter.isAuthorized('user1', 'chat1')).toBe(true);
    });

    it('denies users not in allowedUsers list', () => {
      expect(adapter.isAuthorized('unknown', 'chat1')).toBe(false);
    });

    it('allows all users when allowedUsers is empty', () => {
      const open = new FeishuAdapter({ appId: 'id', appSecret: 'sec', verificationToken: '', encryptKey: '', webhookPort: 0, allowedUsers: [] });
      expect(open.isAuthorized('anyone', 'anychat')).toBe(true);
    });
  });

  describe('send()', () => {
    it('always sends interactive card', async () => {
      await adapter.start();
      const result = await adapter.send({
        chatId: 'oc_chat123',
        text: 'Hello from TermLive',
      });

      expect(mockMessageCreate).toHaveBeenCalledOnce();
      const call = mockMessageCreate.mock.calls[0][0];
      expect(call.data.msg_type).toBe('interactive');
      const card = JSON.parse(call.data.content);
      expect(card.config.wide_screen_mode).toBe(true);
      expect(card.body.elements[0].tag).toBe('markdown');
      expect(card.body.elements[0].content).toBe('Hello from TermLive');

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-feishu-1');
      await adapter.stop();
    });

    it('normalizes headings and spacing before building card markdown', async () => {
      await adapter.start();
      await adapter.send({
        chatId: 'oc_chat123',
        text: 'Hello\n## Title\nBody',
      });

      const call = mockMessageCreate.mock.calls[0][0];
      const card = JSON.parse(call.data.content);
      expect(card.body.elements[0].content).toBe('Hello\n\n**Title**\n\nBody');
      await adapter.stop();
    });

    it('normalizes direct feishuElements markdown content before sending card', async () => {
      await adapter.start();
      await adapter.send({
        chatId: 'oc_chat123',
        feishuHeader: { template: 'blue', title: 'Test' },
        feishuElements: [
          { tag: 'markdown', content: 'Intro\n## Title\nBody' },
          { tag: 'hr' },
        ],
      });

      const call = mockMessageCreate.mock.calls[0][0];
      const card = JSON.parse(call.data.content);
      expect(card.body.elements[0].content).toBe('Intro\n\n**Title**\n\nBody');
      expect(card.body.elements[1]).toEqual({ tag: 'hr' });
      await adapter.stop();
    });
    it('includes action buttons in card when provided', async () => {
      await adapter.start();
      await adapter.send({
        chatId: 'oc_chat123',
        text: 'Permission?',
        buttons: [
          { label: 'Allow', callbackData: 'perm:allow:123', style: 'primary' },
          { label: 'Deny', callbackData: 'perm:deny:123', style: 'danger' },
        ],
      });

      const call = mockMessageCreate.mock.calls[0][0];
      const card = JSON.parse(call.data.content);
      // Schema 2.0: buttons in column_set with behaviors
      expect(card.body.elements[1].tag).toBe('column_set');
      expect(card.body.elements[1].columns).toHaveLength(2);
      const btn0 = card.body.elements[1].columns[0].elements[0];
      const btn1 = card.body.elements[1].columns[1].elements[0];
      expect(btn0.tag).toBe('button');
      expect(btn0.text.content).toBe('Allow');
      expect(btn1.type).toBe('danger');
      await adapter.stop();
    });

    it('sets receive_id and receive_id_type correctly', async () => {
      await adapter.start();
      await adapter.send({ chatId: 'oc_specific_chat', text: 'hi' });

      const call = mockMessageCreate.mock.calls[0][0];
      expect(call.params.receive_id_type).toBe('chat_id');
      expect(call.data.receive_id).toBe('oc_specific_chat');
      await adapter.stop();
    });

    it('passes root_id when replyToMessageId is set', async () => {
      await adapter.start();
      await adapter.send({
        chatId: 'oc_chat123',
        text: 'Reply text',
        replyToMessageId: 'msg-parent-1',
      });

      const call = mockMessageCreate.mock.calls[0][0];
      expect(call.data.root_id).toBe('msg-parent-1');
      await adapter.stop();
    });

    it('throws when client is not started', async () => {
      await expect(adapter.send({ chatId: 'oc_chat123', text: 'hi' })).rejects.toThrow(
        'Feishu client not started',
      );
    });
  });

  describe('start() / stop()', () => {
    it('initializes client and WSClient on start', async () => {
      await adapter.start();
      expect(mockWsStart).toHaveBeenCalledOnce();
      await expect(
        adapter.send({ chatId: 'oc_chat', text: 'test' }),
      ).resolves.toBeDefined();
      await adapter.stop();
    });

    it('clears client on stop so subsequent sends fail', async () => {
      await adapter.start();
      await adapter.stop();
      await expect(adapter.send({ chatId: 'oc_chat', text: 'test' })).rejects.toThrow(
        'Feishu client not started',
      );
    });
  });

  describe('consumeOne()', () => {
    it('returns null when queue is empty', async () => {
      const msg = await adapter.consumeOne();
      expect(msg).toBeNull();
    });
  });

  describe('editMessage()', () => {
    it('silently ignores errors (non-fatal)', async () => {
      await adapter.start();
      mockMessagePatch.mockRejectedValueOnce(new Error('400 not a card'));
      // Should not throw
      await adapter.editMessage('oc_chat123', 'msg-feishu-1', {
        chatId: 'oc_chat123',
        text: 'Updated content',
      });
      await adapter.stop();
    });

    it('does nothing when client is not started', async () => {
      await adapter.editMessage('oc_chat', 'msg-1', { chatId: 'oc_chat', text: 'hi' });
      expect(mockMessagePatch).not.toHaveBeenCalled();
    });
  });

  describe('sendTyping()', () => {
    it('is a no-op that resolves without error', async () => {
      await adapter.start();
      await expect(adapter.sendTyping('oc_chat123')).resolves.toBeUndefined();
      await adapter.stop();
    });
  });

  describe('event handling via WSClient', () => {
    it('processes text messages and strips @mentions', async () => {
      await adapter.start();

      // Simulate event handler being called (via registered handler)
      await mockEventHandler({
        message: {
          message_id: 'msg_1', chat_id: 'chat_1',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 Hello' }),
        },
        sender: { sender_id: { user_id: 'user_1', open_id: 'ou_123' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg).not.toBeNull();
      expect(msg!.text).toBe('Hello');
      expect(msg!.chatId).toBe('chat_1');
      expect(msg!.userId).toBe('user_1');

      await adapter.stop();
    });

    it('uses open_id when user_id is empty', async () => {
      await adapter.start();

      await mockEventHandler({
        message: {
          message_id: 'msg_1', chat_id: 'chat_1',
          message_type: 'text',
          content: JSON.stringify({ text: 'hi' }),
        },
        sender: { sender_id: { user_id: '', open_id: 'ou_456' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg!.userId).toBe('ou_456');

      await adapter.stop();
    });

    it('extracts replyToMessageId from parent_id or root_id', async () => {
      await adapter.start();

      await mockEventHandler({
        message: {
          message_id: 'msg_2', chat_id: 'chat_1',
          message_type: 'text',
          content: JSON.stringify({ text: 'reply' }),
          root_id: 'msg_parent',
        },
        sender: { sender_id: { user_id: 'user_1' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg!.replyToMessageId).toBe('msg_parent');

      await adapter.stop();
    });
  });
});
