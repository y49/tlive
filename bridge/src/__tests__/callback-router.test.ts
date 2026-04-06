import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallbackRouter } from '../engine/callback-router.js';
import type { SdkQuestionState } from '../engine/callback-router.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';

function mockAdapter(channelType = 'telegram'): BaseChannelAdapter {
  const messageQueue: any[] = [];
  return {
    channelType,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    consumeOne: vi.fn().mockImplementation(() => messageQueue.shift() ?? null),
    send: vi.fn().mockResolvedValue({ messageId: '1', success: true }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    validateConfig: vi.fn().mockReturnValue(null),
    isAuthorized: vi.fn().mockReturnValue(true),
    _pushMessage: (msg: any) => messageQueue.push(msg),
  } as any;
}

function createMockGateway() {
  return {
    resolve: vi.fn(),
    pendingCount: vi.fn().mockReturnValue(0),
  };
}

function createMockPermissions(gateway = createMockGateway()) {
  return {
    resolveAskQuestion: vi.fn().mockResolvedValue(undefined),
    toggleMultiSelectOption: vi.fn().mockReturnValue(new Set<number>()),
    buildMultiSelectCard: vi.fn().mockReturnValue({
      text: 'card text',
      html: '<b>card</b>',
      buttons: [{ text: 'Submit', callbackData: 'askq_submit:h1:s1' }],
    }),
    resolveMultiSelect: vi.fn().mockResolvedValue(undefined),
    resolveAskQuestionSkip: vi.fn().mockResolvedValue(undefined),
    getToggledSelections: vi.fn().mockReturnValue(new Set<number>()),
    cleanupQuestion: vi.fn(),
    getGateway: vi.fn().mockReturnValue(gateway),
    resolveHookCallback: vi.fn().mockResolvedValue(undefined),
    addAllowedTool: vi.fn(),
    addAllowedBashPrefix: vi.fn(),
    handleBrokerCallback: vi.fn(),
  };
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelType: 'telegram',
    chatId: 'c1',
    userId: 'u1',
    text: '',
    messageId: 'm1',
    ...overrides,
  };
}

describe('CallbackRouter', () => {
  let adapter: BaseChannelAdapter;
  let permissions: ReturnType<typeof createMockPermissions>;
  let gateway: ReturnType<typeof createMockGateway>;
  let sdkState: SdkQuestionState;
  let handleInboundMessage: ReturnType<typeof vi.fn>;
  let router: CallbackRouter;

  beforeEach(() => {
    adapter = mockAdapter();
    gateway = createMockGateway();
    permissions = createMockPermissions(gateway);
    sdkState = {
      sdkQuestionData: new Map(),
      sdkQuestionAnswers: new Map(),
      sdkQuestionTextAnswers: new Map(),
    };
    handleInboundMessage = vi.fn().mockResolvedValue(true);
    router = new CallbackRouter(
      permissions as any,
      sdkState,
      () => true,
      handleInboundMessage,
    );
  });

  it('returns false when no callbackData', async () => {
    const result = await router.handle(adapter, makeMsg({ callbackData: undefined }));
    expect(result).toBe(false);
  });

  describe('suggest:', () => {
    it('re-injects suggestion as text message and calls handleInboundMessage', async () => {
      const msg = makeMsg({ callbackData: 'suggest:Hello world' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(handleInboundMessage).toHaveBeenCalledWith(adapter, expect.objectContaining({
        text: 'Hello world',
        callbackData: undefined,
      }));
    });
  });

  describe('askq:{hookId}:{idx}:{sessionId}', () => {
    it('resolves single-select hook answer', async () => {
      const msg = makeMsg({ callbackData: 'askq:h1:2:sess1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(permissions.resolveAskQuestion).toHaveBeenCalledWith(
        'h1', 2, 'sess1', 'm1', adapter, 'c1', true,
      );
    });

    it('handles missing sessionId gracefully', async () => {
      const msg = makeMsg({ callbackData: 'askq:h1:0' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(permissions.resolveAskQuestion).toHaveBeenCalledWith(
        'h1', 0, '', 'm1', adapter, 'c1', true,
      );
    });
  });

  describe('askq_toggle:{hookId}:{idx}:{sessionId}', () => {
    it('toggles multi-select option and rebuilds card', async () => {
      permissions.toggleMultiSelectOption.mockReturnValue(new Set([0, 2]));
      const msg = makeMsg({ callbackData: 'askq_toggle:h1:2:sess1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(permissions.toggleMultiSelectOption).toHaveBeenCalledWith('h1', 2);
      expect(permissions.buildMultiSelectCard).toHaveBeenCalledWith('h1', 'sess1', new Set([0, 2]), 'telegram');
      expect(adapter.editMessage).toHaveBeenCalledWith('c1', 'm1', expect.objectContaining({
        text: 'card text',
        buttons: expect.any(Array),
      }));
    });

    it('returns true without editing when toggle returns null', async () => {
      permissions.toggleMultiSelectOption.mockReturnValue(null);
      const msg = makeMsg({ callbackData: 'askq_toggle:h1:0:sess1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(adapter.editMessage).not.toHaveBeenCalled();
    });

    it('returns true without editing when buildMultiSelectCard returns null', async () => {
      permissions.toggleMultiSelectOption.mockReturnValue(new Set([1]));
      permissions.buildMultiSelectCard.mockReturnValue(null);
      const msg = makeMsg({ callbackData: 'askq_toggle:h1:1:sess1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(adapter.editMessage).not.toHaveBeenCalled();
    });

    it('passes feishuHeader when adapter is feishu', async () => {
      const feishuAdapter = mockAdapter('feishu');
      permissions.toggleMultiSelectOption.mockReturnValue(new Set([0]));
      const msg = makeMsg({ callbackData: 'askq_toggle:h1:0:sess1', channelType: 'feishu' });
      await router.handle(feishuAdapter, msg);

      expect(feishuAdapter.editMessage).toHaveBeenCalledWith('c1', 'm1', expect.objectContaining({
        feishuHeader: { template: 'blue', title: '❓ Terminal' },
      }));
    });
  });

  describe('askq_submit:{hookId}:{sessionId}', () => {
    it('resolves multi-select submit', async () => {
      const msg = makeMsg({ callbackData: 'askq_submit:h1:sess1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(permissions.resolveMultiSelect).toHaveBeenCalledWith(
        'h1', 'sess1', 'm1', adapter, 'c1', true,
      );
    });
  });

  describe('askq_skip:{hookId}:{sessionId}', () => {
    it('resolves skip handler', async () => {
      const msg = makeMsg({ callbackData: 'askq_skip:h1:sess1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(permissions.resolveAskQuestionSkip).toHaveBeenCalledWith(
        'h1', 'sess1', 'm1', adapter, 'c1', true,
      );
    });
  });

  describe('askq_submit_sdk:{permId}', () => {
    it('sends warning when no options selected', async () => {
      permissions.getToggledSelections.mockReturnValue(new Set());
      const msg = makeMsg({ callbackData: 'askq_submit_sdk:p1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
        text: '⚠️ No options selected',
      }));
      expect(gateway.resolve).not.toHaveBeenCalled();
    });

    it('resolves gateway with selected labels when options exist', async () => {
      permissions.getToggledSelections.mockReturnValue(new Set([0, 2]));
      sdkState.sdkQuestionData.set('p1', {
        questions: [{
          question: 'Pick tools',
          header: 'Tools',
          options: [
            { label: 'Alpha' },
            { label: 'Beta' },
            { label: 'Gamma' },
          ],
          multiSelect: true,
        }],
        chatId: 'c1',
      });

      const msg = makeMsg({ callbackData: 'askq_submit_sdk:p1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(sdkState.sdkQuestionTextAnswers.get('p1')).toBe('Alpha, Gamma');
      expect(permissions.cleanupQuestion).toHaveBeenCalledWith('p1');
      expect(gateway.resolve).toHaveBeenCalledWith('p1', 'allow');
      expect(adapter.editMessage).toHaveBeenCalledWith('c1', 'm1', expect.objectContaining({
        text: '✅ Selected: Alpha, Gamma',
        buttons: [],
      }));
    });
  });

  describe('hook:allow:{hookId}:{sessionId}', () => {
    it('resolves hook permission allow', async () => {
      const msg = makeMsg({ callbackData: 'hook:allow:h1:sess1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(permissions.resolveHookCallback).toHaveBeenCalledWith(
        'h1', 'allow', 'sess1', 'm1', adapter, 'c1', true,
      );
    });
  });

  describe('hook:deny:{hookId}:{sessionId}', () => {
    it('resolves hook permission deny', async () => {
      const msg = makeMsg({ callbackData: 'hook:deny:h1:sess1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(permissions.resolveHookCallback).toHaveBeenCalledWith(
        'h1', 'deny', 'sess1', 'm1', adapter, 'c1', true,
      );
    });
  });

  describe('perm:allow_edits:{permId}', () => {
    it('resolves gateway for graduated permission', async () => {
      const msg = makeMsg({ callbackData: 'perm:allow_edits:p1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(gateway.resolve).toHaveBeenCalledWith('p1', 'allow');
    });
  });

  describe('perm:allow_tool:{permId}:{toolName}', () => {
    it('resolves gateway and adds tool to whitelist', async () => {
      const msg = makeMsg({ callbackData: 'perm:allow_tool:p1:WriteFile' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(gateway.resolve).toHaveBeenCalledWith('p1', 'allow');
      expect(permissions.addAllowedTool).toHaveBeenCalledWith('WriteFile');
    });

    it('handles tool names with colons', async () => {
      const msg = makeMsg({ callbackData: 'perm:allow_tool:p1:mcp:some:tool' });
      await router.handle(adapter, msg);

      expect(gateway.resolve).toHaveBeenCalledWith('p1', 'allow');
      expect(permissions.addAllowedTool).toHaveBeenCalledWith('mcp:some:tool');
    });
  });

  describe('perm:allow_bash:{permId}:{prefix}', () => {
    it('resolves gateway and adds bash prefix to whitelist', async () => {
      const msg = makeMsg({ callbackData: 'perm:allow_bash:p1:npm run' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(gateway.resolve).toHaveBeenCalledWith('p1', 'allow');
      expect(permissions.addAllowedBashPrefix).toHaveBeenCalledWith('npm run');
    });

    it('handles prefixes with colons', async () => {
      const msg = makeMsg({ callbackData: 'perm:allow_bash:p1:docker:compose' });
      await router.handle(adapter, msg);

      expect(permissions.addAllowedBashPrefix).toHaveBeenCalledWith('docker:compose');
    });
  });

  describe('perm:allow:{permId}:askq:{idx} — SDK answer callback', () => {
    it('resolves gateway with selected option and edits message', async () => {
      sdkState.sdkQuestionData.set('p1', {
        questions: [{
          question: 'Pick one',
          header: 'Choice',
          options: [
            { label: 'Option A' },
            { label: 'Option B' },
          ],
          multiSelect: false,
        }],
        chatId: 'c1',
      });

      const msg = makeMsg({ callbackData: 'perm:allow:p1:askq:1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(sdkState.sdkQuestionAnswers.get('p1')).toBe(1);
      expect(gateway.resolve).toHaveBeenCalledWith('p1', 'allow');
      expect(adapter.editMessage).toHaveBeenCalledWith('c1', 'm1', expect.objectContaining({
        text: '✅ Selected: Option B',
        buttons: [],
      }));
    });

    it('returns true without resolving when option index is out of range', async () => {
      sdkState.sdkQuestionData.set('p1', {
        questions: [{
          question: 'Pick one',
          header: 'Choice',
          options: [{ label: 'Only' }],
          multiSelect: false,
        }],
        chatId: 'c1',
      });

      const msg = makeMsg({ callbackData: 'perm:allow:p1:askq:5' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(gateway.resolve).not.toHaveBeenCalled();
    });
  });

  describe('perm:allow:{permId}:askq_skip — SDK skip callback', () => {
    it('resolves gateway with deny/Skipped and edits message', async () => {
      const msg = makeMsg({ callbackData: 'perm:allow:p1:askq_skip' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(gateway.resolve).toHaveBeenCalledWith('p1', 'deny', 'Skipped');
      expect(adapter.editMessage).toHaveBeenCalledWith('c1', 'm1', expect.objectContaining({
        text: '⏭ Skipped',
        buttons: [],
      }));
    });
  });

  describe('perm:allow:p1 / perm:deny:p1 — regular broker callback (fallback)', () => {
    it('delegates perm:allow to handleBrokerCallback', async () => {
      const msg = makeMsg({ callbackData: 'perm:allow:p1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(permissions.handleBrokerCallback).toHaveBeenCalledWith('perm:allow:p1');
    });

    it('delegates perm:deny to handleBrokerCallback', async () => {
      const msg = makeMsg({ callbackData: 'perm:deny:p1' });
      const result = await router.handle(adapter, msg);

      expect(result).toBe(true);
      expect(permissions.handleBrokerCallback).toHaveBeenCalledWith('perm:deny:p1');
    });
  });
});
