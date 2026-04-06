import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRouter } from '../engine/message-router.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, FileAttachment } from '../channels/types.js';

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
    pendingPermissionCount: vi.fn().mockReturnValue(0),
    findHookPermission: vi.fn().mockReturnValue(null),
    resolveHookPermission: vi.fn().mockResolvedValue(undefined),
    getLatestPendingQuestion: vi.fn().mockReturnValue(null),
    getQuestionData: vi.fn().mockReturnValue(null),
    resolveAskQuestion: vi.fn().mockResolvedValue(undefined),
    resolveAskQuestionWithText: vi.fn().mockResolvedValue(undefined),
    isHookMessage: vi.fn().mockReturnValue(false),
    getHookMessage: vi.fn().mockReturnValue(null),
    storeQuestionData: vi.fn(),
    trackPermissionMessage: vi.fn(),
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
  let coreAvailable: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    permissions = mockPermissions();
    state = mockState();
    sdkEngine = mockSdkEngine();
    coreAvailable = vi.fn().mockReturnValue(true);
    adapter = mockAdapter();

    router = new MessageRouter(
      permissions as any,
      state as any,
      sdkEngine as any,
      coreAvailable,
      'http://localhost:4590',
      'test-token',
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

  // ── 8. Multiple pending permissions ──────────────────────────────────

  describe('multiple pending permissions', () => {
    it('warns user to quote-reply when >1 pending and no replyToMessageId', async () => {
      permissions.parsePermissionText.mockReturnValue('allow');
      permissions.tryResolveByText.mockReturnValue(false);
      permissions.pendingPermissionCount.mockReturnValue(2);

      const result = await router.route(adapter, makeMsg({ text: 'allow' }));

      expect(result).toEqual({ action: 'handled' });
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Multiple permissions pending') }),
      );
    });
  });

  // ── 9. Hook permission text ──────────────────────────────────────────

  describe('hook permission text', () => {
    it('resolves via hook permission on quote-reply', async () => {
      permissions.parsePermissionText.mockReturnValue('allow');
      permissions.tryResolveByText.mockReturnValue(false);
      permissions.pendingPermissionCount.mockReturnValue(1);
      permissions.findHookPermission.mockReturnValue({ permissionId: 'hp1' });

      const result = await router.route(adapter, makeMsg({
        text: 'allow',
        replyToMessageId: 'perm-msg-1',
      }));

      expect(result).toEqual({ action: 'handled' });
      expect(permissions.resolveHookPermission).toHaveBeenCalledWith('hp1', 'allow', 'telegram', true);
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Allowed') }),
      );
    });
  });

  // ── 10-14. AskQuestion text reply ────────────────────────────────────

  describe('AskQuestion text reply', () => {
    it('numeric reply selects option (hook)', async () => {
      permissions.getLatestPendingQuestion.mockReturnValue({
        hookId: 'hq1',
        sessionId: 'sess1',
        messageId: 'qmsg1',
      });
      permissions.getQuestionData.mockReturnValue({
        questions: [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
      });

      const result = await router.route(adapter, makeMsg({ text: '2' }));

      expect(result).toEqual({ action: 'handled' });
      expect(permissions.resolveAskQuestion).toHaveBeenCalledWith(
        'hq1', 1, 'sess1', 'qmsg1', adapter, 'c1', true,
      );
    });

    it('numeric reply selects option (SDK)', async () => {
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

    it('free text answer (hook)', async () => {
      permissions.getLatestPendingQuestion.mockReturnValue({
        hookId: 'hq2',
        sessionId: 'sess2',
        messageId: 'qmsg2',
      });
      permissions.getQuestionData.mockReturnValue({
        questions: [{ question: 'What?', options: [] }],
      });

      const result = await router.route(adapter, makeMsg({ text: 'my answer' }));

      expect(result).toEqual({ action: 'handled' });
      expect(permissions.resolveAskQuestionWithText).toHaveBeenCalledWith(
        'hq2', 'my answer', 'sess2', 'qmsg2', adapter, 'c1', true,
      );
    });

    it('free text answer (SDK)', async () => {
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

    it('out-of-range number falls through to free text', async () => {
      permissions.getLatestPendingQuestion.mockReturnValue({
        hookId: 'hq3',
        sessionId: 'sess3',
        messageId: 'qmsg3',
      });
      permissions.getQuestionData.mockReturnValue({
        questions: [{ question: 'Pick', options: [{ label: 'A' }] }],
      });

      const result = await router.route(adapter, makeMsg({ text: '99' }));

      expect(result).toEqual({ action: 'handled' });
      // Should call free text, not numeric resolve
      expect(permissions.resolveAskQuestion).not.toHaveBeenCalled();
      expect(permissions.resolveAskQuestionWithText).toHaveBeenCalledWith(
        'hq3', '99', 'sess3', 'qmsg3', adapter, 'c1', true,
      );
    });
  });

  // ── 15. Hook reply routing ───────────────────────────────────────────

  describe('hook reply routing', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('routes reply to hook message via fetch and confirms', async () => {
      permissions.isHookMessage.mockReturnValue(true);
      permissions.getHookMessage.mockReturnValue({ sessionId: 'sess-x' });

      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: false }) // pending endpoint fails → skip AskQ check
        .mockResolvedValueOnce({ ok: true }) as any; // session input succeeds

      const result = await router.route(adapter, makeMsg({
        text: 'some input',
        replyToMessageId: 'hook-msg-1',
      }));

      expect(result).toEqual({ action: 'handled' });
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:4590/api/sessions/sess-x/input',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: '✓ Sent to local session' }),
      );
    });

    it('shows error when fetch to session input fails', async () => {
      permissions.isHookMessage.mockReturnValue(true);
      permissions.getHookMessage.mockReturnValue({ sessionId: 'sess-y' });

      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: false }) // pending endpoint
        .mockRejectedValueOnce(new Error('connection refused')) as any;

      const result = await router.route(adapter, makeMsg({
        text: 'some input',
        replyToMessageId: 'hook-msg-2',
      }));

      expect(result).toEqual({ action: 'handled' });
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Failed to send') }),
      );
    });

    it('resolves AskUserQuestion found in pending hooks', async () => {
      permissions.isHookMessage.mockReturnValue(true);
      permissions.getHookMessage.mockReturnValue({ sessionId: 'sess-z' });
      permissions.getQuestionData.mockReturnValue(null);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{
          id: 'ask-1',
          tool_name: 'AskUserQuestion',
          input: { questions: [{ question: 'Pick one', header: '', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] },
          session_id: 'sess-z',
        }],
      }) as any;

      const result = await router.route(adapter, makeMsg({
        text: '1',
        replyToMessageId: 'hook-msg-3',
      }));

      expect(result).toEqual({ action: 'handled' });
      expect(permissions.storeQuestionData).toHaveBeenCalledWith('ask-1', expect.any(Array));
      expect(permissions.resolveAskQuestion).toHaveBeenCalledWith(
        'ask-1', 0, 'sess-z', 'hook-msg-3', adapter, 'c1', true,
      );
    });
  });

  // ── 16. Pass-through ─────────────────────────────────────────────────

  describe('pass-through', () => {
    it('regular text message returns pass', async () => {
      const result = await router.route(adapter, makeMsg({ text: 'just chatting' }));
      expect(result).toEqual({ action: 'pass' });
    });
  });
});
