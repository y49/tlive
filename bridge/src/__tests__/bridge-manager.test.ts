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
    process.env.TL_DEFAULT_WORKDIR = '/tmp';
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
      lifecycle: undefined,
    });
    manager = new BridgeManager({ workspacesPersistPath: null });
  });

  afterEach(() => {
    delete process.env.TL_DEFAULT_WORKDIR;
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
      'c1',
      expect.objectContaining({ html: expect.stringContaining('normal') })
    );
  });

  it('handles /verbose with invalid arg', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/verbose 5', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ html: expect.stringContaining('Usage') })
    );
  });

  it('handles /verbose with no arg — shows current value', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    // First set a value via /verbose 1 (lazy-binds workspace, stores pref)
    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/verbose 1', messageId: 'm1',
    });

    // Then /verbose with no arg — should show "normal" as current value
    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/verbose', messageId: 'm2',
    });

    const lastCall = (adapter.send as any).mock.calls.at(-1);
    expect(lastCall[1].html).toContain('Verbose:');
    expect(lastCall[1].html).toContain('normal');
    expect(lastCall[1].html).toContain('Usage');
  });

  it('handles /new command with rebind', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/new', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ html: expect.stringContaining('New Session') })
    );
  });

  it('updates /help text to include /verbose', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/help', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      'c1',
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


  describe('/hooks command', () => {
    it('shows hook status', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/hooks', messageId: 'm1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ html: expect.stringContaining('Hooks:') })
      );
    });

    it('handles /hooks pause', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/hooks pause', messageId: 'm1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ html: expect.stringContaining('paused') })
      );
    });

    it('handles /hooks resume', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/hooks resume', messageId: 'm1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ html: expect.stringContaining('resumed') })
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
      'c1',
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
      'c1',
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
      'c1',
      expect.objectContaining({
        embed: expect.objectContaining({ title: expect.stringContaining('New Session') }),
      })
    );
  });

  it('auto-registers a default workspace for defaultWorkdir at bootstrap', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    // The workspace manager should have exactly one workspace after bootstrap,
    // matching defaultWorkdir with source='auto'
    const workspaces = (manager as any).workspaceManager.list();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].workdir).toBe('/tmp');
    expect(workspaces[0].name).toBe('tmp');
    expect(workspaces[0].source).toBe('auto');
    expect(workspaces[0].chatId).toBeUndefined();

    // And /workspaces renders it
    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/workspaces', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ html: expect.stringContaining('tmp') })
    );
  });

  it('lazy-binds default workspace to the first authorized chat', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    // Before any message: default ws exists, unbound
    const ws = (manager as any).workspaceManager;
    const defaultBefore = ws.getDefault();
    expect(defaultBefore).toBeDefined();
    expect(defaultBefore.chatId).toBeUndefined();

    // First real authorized message in chat c1
    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/verbose 1', messageId: 'm1',
    });

    // Default ws is now bound to c1
    const defaultAfter = ws.findByName(defaultBefore.name);
    expect(defaultAfter.chatId).toBe('c1');
    expect(ws.getDefault()).toBeUndefined(); // one-shot
  });

  it('does not lazy-bind on unauthorized messages', async () => {
    const adapter = mockAdapter();
    (adapter.isAuthorized as any).mockReturnValue(false);
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'hello', messageId: 'm1',
    });

    // Default ws still unbound — auth gate fired before lazy-bind
    const ws = (manager as any).workspaceManager;
    expect(ws.getDefault()).toBeDefined();
    expect(ws.getDefault().chatId).toBeUndefined();
  });

  it('does not lazy-bind on callback data (button presses)', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c-cb', userId: 'u1', text: '',
      callbackData: 'perm:allow:p1', messageId: 'm1',
    });

    // Callback path skips lazy-bind
    const ws = (manager as any).workspaceManager;
    expect(ws.getDefault()).toBeDefined();
    expect(ws.getDefault().chatId).toBeUndefined();
  });

  it('second chat after lazy-bind gets no auto-workspace (one-shot)', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    // Chat 1 binds the default
    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'first', messageId: 'm1',
    });

    // Chat 2 — no more default to grab
    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c2', userId: 'u2', text: 'second', messageId: 'm2',
    });

    const ws = (manager as any).workspaceManager;
    // Only the c1-bound default exists
    expect(ws.list()).toHaveLength(1);
    expect(ws.list()[0].chatId).toBe('c1');
  });

  it('routes per-workspace commands using (chatId, threadId) — forum topic case', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    // First message from inside a forum topic — lazy-bind captures threadId
    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/perm on',
      messageId: 'm1', threadId: 'topic-42',
    });

    const ws = (manager as any).workspaceManager;
    const defaultWs = ws.list()[0];
    expect(defaultWs.chatId).toBe('c1');
    expect(defaultWs.threadId).toBe('topic-42');
    // The /perm on command must route to the workspace (not per-chat state)
    expect(defaultWs.perm).toBe('on');

    // Subsequent command from same topic should also route to this workspace
    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/perm off',
      messageId: 'm2', threadId: 'topic-42',
    });
    expect(ws.list()[0].perm).toBe('off');

    // A command from the SAME chat but DIFFERENT topic should NOT find this workspace
    // (falls back to per-chat state — workspace pref unchanged)
    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/perm on',
      messageId: 'm3', threadId: 'topic-99',
    });
    expect(ws.list()[0].perm).toBe('off'); // unchanged — different topic
  });
});
