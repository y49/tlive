import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageRouter } from '../engine/message-router.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, ChannelType, FileAttachment } from '../channels/types.js';
import type { NotificationRenderer } from '../renderers/types.js';
import { TelegramRenderer } from '../renderers/telegram.js';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => { throw new Error('not found'); }),
}));

function mockAdapter(channelType = 'telegram'): BaseChannelAdapter & { requestPairing?: ReturnType<typeof vi.fn> } {
  return {
    channelType,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    consumeOne: vi.fn().mockReturnValue(null),
    send: vi.fn().mockResolvedValue({ messageId: 'sent-1', success: true }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    validateConfig: vi.fn().mockReturnValue(null),
    isAuthorized: vi.fn().mockReturnValue(true),
  } as any;
}

function mockPermissions() {
  return {
    parsePermissionText: vi.fn().mockReturnValue(null),
    tryResolveByText: vi.fn().mockReturnValue(false),
    getGateway: vi.fn().mockReturnValue({
      isPending: vi.fn().mockReturnValue(false),
      resolve: vi.fn(),
    }),
  };
}

function mockState() {
  return {
    stateKey: vi.fn((channelType: string, chatId: string) => `${channelType}:${chatId}`),
  };
}

function mockSdkEngine() {
  return {
    findPendingQuestion: vi.fn().mockReturnValue(null),
    getQuestionState: vi.fn().mockReturnValue({
      sdkQuestionData: new Map(),
      sdkQuestionAnswers: new Map(),
      sdkQuestionTextAnswers: new Map(),
    }),
  };
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelType: 'telegram',
    chatId: 'c1',
    userId: 'u1',
    text: 'hello',
    messageId: 'm1',
    ...overrides,
  };
}

function makeAttachment(sizeBytes = 100): FileAttachment {
  return {
    type: 'image',
    name: 'img.png',
    mimeType: 'image/png',
    base64Data: 'A'.repeat(sizeBytes),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('MessageRouter', () => {
  let router: MessageRouter;
  let permissions: ReturnType<typeof mockPermissions>;
  let state: ReturnType<typeof mockState>;
  let sdkEngine: ReturnType<typeof mockSdkEngine>;
  let adapter: ReturnType<typeof mockAdapter>;
  beforeEach(() => {
    permissions = mockPermissions();
    state = mockState();
    sdkEngine = mockSdkEngine();
    adapter = mockAdapter();

    const renderers = new Map<ChannelType, NotificationRenderer>([
      ['telegram', new TelegramRenderer()],
    ]);
    router = new MessageRouter(
      permissions as any,
      state as any,
      sdkEngine as any,
      renderers,
    );
  });

  // ── 1. Auth ──────────────────────────────────────────────────────────

  describe('auth', () => {
    it('returns unauthorized when adapter rejects user', async () => {
      (adapter.isAuthorized as any).mockReturnValue(false);
      const result = await router.route(adapter, makeMsg());
      expect(result).toEqual({ action: 'unauthorized' });
    });

    it('triggers Telegram pairing flow for unauthorized user', async () => {
      const tgAdapter = mockAdapter('telegram') as any;
      tgAdapter.isAuthorized.mockReturnValue(false);
      tgAdapter.requestPairing = vi.fn().mockReturnValue('ABC123');

      const result = await router.route(tgAdapter, makeMsg({ text: 'hi' }));

      expect(result).toEqual({ action: 'unauthorized' });
      expect(tgAdapter.requestPairing).toHaveBeenCalledWith('u1', 'c1', 'u1');
      expect(tgAdapter.send).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ html: expect.stringContaining('ABC123') }),
      );
    });
  });

  // ── 2. ChatId tracking ──────────────────────────────────────────────

  describe('chatId tracking', () => {
    it('updates lastChatId and returns it via getLastChatId', async () => {
      await router.route(adapter, makeMsg({ chatId: 'chat-42' }));
      expect(router.getLastChatId('telegram')).toBe('chat-42');
    });

    it('returns empty string for unknown channel type', () => {
      expect(router.getLastChatId('slack')).toBe('');
    });
  });

  // ── 3. Attachment buffering ──────────────────────────────────────────

  describe('attachment buffering', () => {
    it('buffers image-only message and returns handled', async () => {
      const msg = makeMsg({ text: '', attachments: [makeAttachment()] });
      const result = await router.route(adapter, msg);
      expect(result).toEqual({ action: 'handled' });
    });

    it('merges buffered attachments into subsequent text message', async () => {
      const att = makeAttachment();
      await router.route(adapter, makeMsg({ text: '', attachments: [att], messageId: 'm-img' }));

      const textMsg = makeMsg({ text: 'describe this', messageId: 'm-txt' });
      const result = await router.route(adapter, textMsg);

      // Message should pass through with attachments merged
      expect(result).toEqual({ action: 'pass' });
      expect(textMsg.attachments).toHaveLength(1);
      expect(textMsg.attachments![0].name).toBe('img.png');
    });
  });

  // ── 4. Attachment limits ─────────────────────────────────────────────

  describe('attachment limits', () => {
    it('enforces max 5 attachments', async () => {
      const atts = Array.from({ length: 7 }, () => makeAttachment(50));
      const msg = makeMsg({ text: '', attachments: atts });
      await router.route(adapter, msg);

      // Now send text to merge
      const textMsg = makeMsg({ text: 'describe' });
      await router.route(adapter, textMsg);
      expect(textMsg.attachments).toHaveLength(5);
    });

    it('trims attachments exceeding 10MB total', async () => {
      const bigSize = 4 * 1024 * 1024; // 4MB each → only 2 fit in 10MB
      const atts = [makeAttachment(bigSize), makeAttachment(bigSize), makeAttachment(bigSize)];
      const msg = makeMsg({ text: '', attachments: atts });
      await router.route(adapter, msg);

      const textMsg = makeMsg({ text: 'describe' });
      await router.route(adapter, textMsg);
      expect(textMsg.attachments!.length).toBe(2);
    });
  });

  // ── 5. Attachment expiry ─────────────────────────────────────────────

  describe('attachment expiry', () => {
    it('discards buffered attachments after 60s', async () => {
      const att = makeAttachment();
      const now = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      await router.route(adapter, makeMsg({ text: '', attachments: [att] }));

      // Advance past 60s
      (Date.now as any).mockReturnValue(now + 61_000);

      const textMsg = makeMsg({ text: 'describe' });
      await router.route(adapter, textMsg);

      expect(textMsg.attachments ?? []).toHaveLength(0);

      vi.restoreAllMocks();
    });
  });

  // ── 6. Permission text: allow ────────────────────────────────────────

  describe('permission text resolution', () => {
    it('"allow" resolves SDK permission and returns handled', async () => {
      permissions.parsePermissionText.mockReturnValue('allow');
      permissions.tryResolveByText.mockReturnValue(true);

      const result = await router.route(adapter, makeMsg({ text: 'allow' }));

      expect(result).toEqual({ action: 'handled' });
      expect(adapter.addReaction).toHaveBeenCalledWith('c1', 'm1', 'OK');
    });

    // ── 7. Permission text: deny ─────────────────────────────────────

    it('"deny" adds NO reaction emoji', async () => {
      permissions.parsePermissionText.mockReturnValue('deny');
      permissions.tryResolveByText.mockReturnValue(true);

      await router.route(adapter, makeMsg({ text: 'deny' }));

      expect(adapter.addReaction).toHaveBeenCalledWith('c1', 'm1', 'NO');
    });
  });

  // ── 8. AskQuestion text reply (SDK) ──────────────────────────────────

  describe('AskQuestion text reply (SDK)', () => {
    it('numeric reply selects option', async () => {
      const sdkAnswers = new Map();
      sdkEngine.findPendingQuestion.mockReturnValue({ permId: 'sp1' });
      sdkEngine.getQuestionState.mockReturnValue({
        sdkQuestionData: new Map([['sp1', { questions: [{ question: 'Pick', options: [{ label: 'X' }, { label: 'Y' }] }] }]]),
        sdkQuestionAnswers: sdkAnswers,
        sdkQuestionTextAnswers: new Map(),
      });

      const gateway = { isPending: vi.fn(), resolve: vi.fn() };
      permissions.getGateway.mockReturnValue(gateway);

      const result = await router.route(adapter, makeMsg({ text: '1' }));

      expect(result).toEqual({ action: 'handled' });
      expect(sdkAnswers.get('sp1')).toBe(0);
      expect(gateway.resolve).toHaveBeenCalledWith('sp1', 'allow');
    });

    it('free text answer', async () => {
      const sdkTextAnswers = new Map();
      sdkEngine.findPendingQuestion.mockReturnValue({ permId: 'sp2' });
      sdkEngine.getQuestionState.mockReturnValue({
        sdkQuestionData: new Map([['sp2', { questions: [{ question: 'What?', options: [] }] }]]),
        sdkQuestionAnswers: new Map(),
        sdkQuestionTextAnswers: sdkTextAnswers,
      });

      const gateway = { isPending: vi.fn(), resolve: vi.fn() };
      permissions.getGateway.mockReturnValue(gateway);

      const result = await router.route(adapter, makeMsg({ text: 'free text' }));

      expect(result).toEqual({ action: 'handled' });
      expect(sdkTextAnswers.get('sp2')).toBe('free text');
      expect(gateway.resolve).toHaveBeenCalledWith('sp2', 'allow');
    });
  });

  // ── 9. Pass-through ─────────────────────────────────────────────────

  describe('pass-through', () => {
    it('regular text message returns pass', async () => {
      const result = await router.route(adapter, makeMsg({ text: 'just chatting' }));
      expect(result).toEqual({ action: 'pass' });
    });
  });
});
