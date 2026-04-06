import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeManager } from '../engine/bridge-manager.js';
import { initBridgeContext } from '../context.js';
import type { BaseChannelAdapter } from '../channels/base.js';

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

describe('BridgeManager', () => {
  let manager: BridgeManager;

  beforeEach(() => {
    // Set required env vars for loadConfig validation
    process.env.TL_TOKEN = 'test-token';
    initBridgeContext({
      defaultWorkdir: '/tmp',
      store: {
        getSession: vi.fn().mockResolvedValue({ id: 's1', workingDirectory: '/tmp', createdAt: '' }),
        saveMessage: vi.fn(), getMessages: vi.fn().mockResolvedValue([]),
        acquireLock: vi.fn().mockResolvedValue(true),
        renewLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
        saveSession: vi.fn(), deleteSession: vi.fn(), listSessions: vi.fn(),
        getBinding: vi.fn().mockResolvedValue({ channelType: 'telegram', chatId: 'c1', sessionId: 's1', createdAt: '' }),
        saveBinding: vi.fn(), deleteBinding: vi.fn(), listBindings: vi.fn(),
        isDuplicate: vi.fn().mockResolvedValue(false), markProcessed: vi.fn(),
      } as any,
      llm: {
        streamChat: () => ({
          stream: new ReadableStream({
            start(c) { c.enqueue({ kind: 'text_delta', text: 'reply' }); c.enqueue({ kind: 'query_result', sessionId: 's1', isError: false, usage: { inputTokens: 0, outputTokens: 0 } }); c.close(); }
          }),
          controls: undefined,
        }),
        capabilities: () => ({ slashCommands: true, askUserQuestion: true, liveSession: true, todoTracking: true, costInUsd: true, skills: true, sessionResume: true }),
      } as any,
      permissions: { resolvePendingPermission: vi.fn() } as any,
      core: { isHealthy: () => true } as any,
    });
    manager = new BridgeManager();
  });

  it('starts adapters', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);
    await manager.start();
    expect(adapter.start).toHaveBeenCalled();
  });

  it('stops adapters', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);
    await manager.start();
    await manager.stop();
    expect(adapter.stop).toHaveBeenCalled();
  });

  it('skips adapters with invalid config', async () => {
    const adapter = mockAdapter();
    (adapter.validateConfig as any).mockReturnValue('missing token');
    manager.registerAdapter(adapter);
    await manager.start();
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it('filters unauthorized messages', async () => {
    const adapter = mockAdapter();
    (adapter.isAuthorized as any).mockReturnValue(false);
    manager.registerAdapter(adapter);

    const processed = await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'hello', messageId: 'm1',
    });
    expect(processed).toBe(false);
  });

  it('routes callback data to permission broker', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    const handled = await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '',
      callbackData: 'perm:allow:p1', messageId: 'm1',
    });
    // Even if permission not found, it should attempt handling
    expect(handled).toBe(true);
  });

  it('routes /status command', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    const handled = await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/status', messageId: 'm1',
    });
    expect(handled).toBe(true);
    expect(adapter.send).toHaveBeenCalled();
  });

  it('sends typing indicator on message', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'hello', messageId: 'm1',
    });

    expect((adapter as any).sendTyping).toHaveBeenCalledWith('c1');
  });

  it('handles /verbose command', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/verbose 1', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('terminal card') })
    );
  });

  it('handles /verbose with invalid arg', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/verbose 5', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Usage') })
    );
  });

  it('handles /new command with rebind', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/new', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining('New session') })
    );
  });

  it('updates /help text to include /verbose', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/help', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining('/verbose') })
    );
  });

  it('expires session after 30 minutes of inactivity', async () => {
    vi.useFakeTimers();
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    // First message — creates session
    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'first', messageId: 'm1',
    });
    const firstSaveBinding = vi.mocked((manager as any).router).rebind;

    // Advance 31 minutes
    vi.advanceTimersByTime(31 * 60 * 1000);

    // Second message — should trigger rebind (new session)
    const store = (await import('../context.js')).getBridgeContext().store;
    const saveBindingSpy = vi.mocked(store.saveBinding);
    const callsBefore = saveBindingSpy.mock.calls.length;

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'second', messageId: 'm2',
    });

    // saveBinding should have been called again (rebind creates new binding)
    expect(saveBindingSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    vi.useRealTimers();
  });

  it('does not expire session within 30 minutes', async () => {
    vi.useFakeTimers();
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'first', messageId: 'm1',
    });

    const store = (await import('../context.js')).getBridgeContext().store;
    const saveBindingSpy = vi.mocked(store.saveBinding);

    // Advance only 10 minutes
    vi.advanceTimersByTime(10 * 60 * 1000);
    const callsBefore = saveBindingSpy.mock.calls.length;

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'second', messageId: 'm2',
    });

    // saveBinding should NOT have been called again (no rebind)
    expect(saveBindingSpy.mock.calls.length).toBe(callsBefore);
    vi.useRealTimers();
  });

  it('clears typing interval on error', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    // Make processMessage throw
    const ctx = (await import('../context.js')).getBridgeContext();
    (ctx.llm as any).streamChat = () => ({
      stream: new ReadableStream({
        start(c) { c.enqueue({ kind: 'error', message: 'boom' }); c.close(); }
      }),
      controls: undefined,
    });

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'fail', messageId: 'm1',
    });

    // clearInterval should have been called (finally block)
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  describe('hook reply routing', () => {
    it('routes quote-reply to hook message via session input API', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      // Simulate a tracked hook message and mark core as available
      manager.trackHookMessage('hook-msg-1', 'session-abc');
      (manager as any).coreAvailable = true;

      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({ ok: true }) as any;

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1',
        text: 'A', messageId: 'm1', replyToMessageId: 'hook-msg-1',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/sessions/session-abc/input'),
        expect.objectContaining({ method: 'POST' })
      );
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: '✓ Sent to local session' })
      );

      global.fetch = originalFetch;
    });

    it('ignores quote-reply to non-hook message', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1',
        text: 'hello', messageId: 'm1', replyToMessageId: 'unknown-msg',
      });

      // Should fall through to normal handling
      expect(adapter.send).toHaveBeenCalled();
    });
  });

  describe('hook notification formatting', () => {
    it('formats stop notification with [Local] prefix', async () => {
      const adapter = mockAdapter();
      await (manager as any).sendHookNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
        tlive_session_id: 'sess-1',
      });

      const sentMsg = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const content = sentMsg.html ?? sentMsg.text ?? '';
      expect(content).toContain('Terminal');
    });

    it('formats idle_prompt notification with message', async () => {
      const adapter = mockAdapter();
      await (manager as any).sendHookNotification(adapter, 'c1', {
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input',
        tlive_session_id: 'sess-1',
      });

      const sentMsg = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const content = sentMsg.html ?? sentMsg.text ?? '';
      expect(content).toContain('Claude is waiting for your input');
    });

    it('tracks hook message for reply routing', async () => {
      const adapter = mockAdapter();
      await (manager as any).sendHookNotification(adapter, 'c1', {
        tlive_hook_type: 'notification',
        tlive_session_id: 'sess-1',
        message: 'test',
      });

      // mockAdapter.send returns { messageId: '1' }
      // hookMessages now live inside PermissionCoordinator
      expect((manager as any).permissions.isHookMessage('1')).toBe(true);
      expect((manager as any).permissions.getHookMessage('1').sessionId).toBe('sess-1');
    });
  });

  describe('/hooks command', () => {
    it('shows hook status', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/hooks', messageId: 'm1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Hooks:') })
      );
    });

    it('handles /hooks pause', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/hooks pause', messageId: 'm1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('paused') })
      );
    });

    it('handles /hooks resume', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/hooks resume', messageId: 'm1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('resumed') })
      );
    });
  });

  it('text-based permission works for Telegram (not only Feishu)', async () => {
    const adapter = mockAdapter('telegram');
    manager.registerAdapter(adapter);

    // The text "allow" should be parsed as a permission decision
    // Without pending permissions, it falls through to normal message handling
    const result = await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'allow', messageId: 'm1',
    });
    // Since no pending permissions, it should proceed to LLM conversation (not return immediately)
    // This verifies the text-based check runs for Telegram now
    expect(result).toBe(true);
  });

  it('Discord /status renders as embed', async () => {
    const adapter = mockAdapter('discord');
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'discord', chatId: 'c1', userId: 'u1', text: '/status', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embed: expect.objectContaining({ title: expect.stringContaining('TLive Status') }),
      })
    );
  });

  it('Discord /help renders as embed', async () => {
    const adapter = mockAdapter('discord');
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'discord', chatId: 'c1', userId: 'u1', text: '/help', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embed: expect.objectContaining({ title: expect.stringContaining('TLive Commands') }),
      })
    );
  });

  it('Discord /new renders as embed', async () => {
    const adapter = mockAdapter('discord');
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'discord', chatId: 'c1', userId: 'u1', text: '/new', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embed: expect.objectContaining({ title: expect.stringContaining('New Session') }),
      })
    );
  });
});
