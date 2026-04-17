import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SDKEngine } from '../engine/sdk-engine.js';
import { initBridgeContext } from '../context.js';

function createMockAdapter(channelType = 'telegram') {
  return {
    channelType,
    send: vi.fn().mockResolvedValue({ messageId: 'm1', success: true }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createStore() {
  return {
    getSession: vi.fn().mockResolvedValue({ id: 's1', workingDirectory: '/', createdAt: '' }),
    saveSession: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    acquireLock: vi.fn().mockResolvedValue(true),
    renewLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    getBinding: vi.fn(),
    saveBinding: vi.fn(),
    deleteBinding: vi.fn(),
    listBindings: vi.fn(),
    listSessions: vi.fn(),
    deleteSession: vi.fn(),
    isDuplicate: vi.fn(),
    markProcessed: vi.fn(),
  };
}

function createState() {
  return {
    checkAndUpdateLastActive: vi.fn().mockReturnValue(false),
    clearThread: vi.fn(),
    clearSessionWhitelist: vi.fn(),
    stateKey: vi.fn().mockImplementation((ct: string, id: string) => `${ct}:${id}`),
    getThread: vi.fn().mockReturnValue(undefined),
    setThread: vi.fn(),
    getPermMode: vi.fn().mockReturnValue('off'),
    getEffort: vi.fn().mockReturnValue(undefined),
    getModel: vi.fn().mockReturnValue(undefined),
    getRuntime: vi.fn().mockReturnValue(undefined),
  } as any;
}

function createRouter(channelType = 'telegram') {
  return {
    resolve: vi.fn().mockResolvedValue({ channelType, chatId: 'c1', sessionId: 's1', createdAt: '' }),
    rebind: vi.fn(),
  } as any;
}

function createPermissions() {
  return {
    clearSessionWhitelist: vi.fn(),
    isToolAllowed: vi.fn().mockReturnValue(false),
    setPendingSdkPerm: vi.fn(),
    clearPendingSdkPerm: vi.fn(),
    getGateway: vi.fn().mockReturnValue({ waitFor: vi.fn(), isPending: vi.fn().mockReturnValue(false) }),
    trackPermissionMessage: vi.fn(),
    storeQuestionData: vi.fn(),
  } as any;
}

function createProvider(events: any[]) {
  const liveSession = {
    isAlive: true,
    isTurnActive: false,
    startTurn: vi.fn(() => ({
      stream: new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(event);
          controller.close();
        },
      }),
      controls: undefined,
    })),
    close: vi.fn(),
    steerTurn: vi.fn(),
  };

  const provider = {
    capabilities: () => ({ liveSession: true, slashCommands: true, askUserQuestion: true, todoTracking: true, costInUsd: true, skills: true, sessionResume: true }),
    createSession: vi.fn(() => liveSession),
    streamChat: vi.fn(),
  } as any;

  return { provider, liveSession };
}

describe('SDKEngine working directory healing', () => {
  let tempRoot: string;
  let defaultWorkdir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'tlive-sdk-'));
    defaultWorkdir = join(tempRoot, 'project');
    mkdirSync(defaultWorkdir, { recursive: true });
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('heals invalid session cwd before live session creation', async () => {
    const store = createStore();
    const { provider } = createProvider([
      { kind: 'query_result', sessionId: 'sdk-1', isError: false, usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    initBridgeContext({
      defaultWorkdir,
      store: store as any,
      llm: provider,
      permissions: {} as any,
      core: {} as any,
    });

    const state = createState();
    const router = createRouter('telegram');
    const permissions = createPermissions();

    const engine = new SDKEngine(state, router, permissions);
    const adapter = createMockAdapter();

    await engine.handleMessage(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: 'hello',
      messageId: 'm1',
    } as any, provider);

    expect(provider.createSession).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: defaultWorkdir }));
    expect(store.saveSession).toHaveBeenCalledWith(expect.objectContaining({
      id: 's1',
      workingDirectory: defaultWorkdir,
    }));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Live turn cwd selection: channelType=telegram chatId=c1 sessionId=s1'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining(`effective=${JSON.stringify(defaultWorkdir)} source=defaultWorkdir healed=true reason=root-path`));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining(`Created LiveSession: registryKey=telegram:c1:${defaultWorkdir}`));
  });
});

describe('SDKEngine channel presentation', () => {
  let tempRoot: string;
  let defaultWorkdir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'tlive-sdk-present-'));
    defaultWorkdir = join(tempRoot, 'project');
    mkdirSync(defaultWorkdir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('uses compact execution rendering for telegram and normalizes outgoing html', async () => {
    const store = createStore();
    const { provider } = createProvider([
      { kind: 'tool_start', id: 'tu-1', name: 'Bash', input: { command: 'pwd' } },
      { kind: 'text_delta', text: 'Hello\n## Title\nBody' },
      { kind: 'query_result', sessionId: 'sdk-1', isError: false, usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    initBridgeContext({
      defaultWorkdir,
      store: store as any,
      llm: provider,
      permissions: {} as any,
      core: {} as any,
    });

    const state = createState();
    const router = createRouter('telegram');
    const permissions = createPermissions();
    const engine = new SDKEngine(state, router, permissions);
    const adapter = createMockAdapter('telegram');

    await engine.handleMessage(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: 'hello',
      messageId: 'm1',
    } as any, provider);

    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.editMessage).not.toHaveBeenCalled();
    const sent = adapter.send.mock.calls[0][0];
    expect(sent.html).toContain('<b>Title</b>');
    expect(sent.html).toContain('Hello');
    expect(sent.html).toContain('Body');
    expect(sent.html).toContain('🖥️ Bash ×1');
    expect(sent.html).not.toContain('<b>⏳ Working');
  });

  it('uses multipart intro and labels for telegram adapter send preparation', async () => {
    const adapter = createMockAdapter('telegram');
    const longBody = ('## Title\nBody paragraph\n\n').repeat(500);

    const sendPayload = {
      chatId: 'c1',
      html: longBody,
    } as any;

    expect(adapter.send).toHaveBeenCalledTimes(0);
    await adapter.send(sendPayload);
    expect(adapter.send).toHaveBeenCalledTimes(1);

    expect(sendPayload.html).toContain('## Title');
  });

  it('uses verbose execution rendering for feishu and sends normalized plain text', async () => {
    const store = createStore();
    const { provider } = createProvider([
      { kind: 'tool_start', id: 'tu-1', name: 'Bash', input: { command: 'pwd' } },
      { kind: 'todo_update', todos: [{ content: 'Ship it', status: 'in_progress' }] },
      { kind: 'text_delta', text: 'Hello\n## Title\nBody' },
      { kind: 'query_result', sessionId: 'sdk-1', isError: false, usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    initBridgeContext({
      defaultWorkdir,
      store: store as any,
      llm: provider,
      permissions: {} as any,
      core: {} as any,
    });

    const state = createState();
    const router = createRouter('feishu');
    const permissions = createPermissions();
    const engine = new SDKEngine(state, router, permissions);
    const adapter = createMockAdapter('feishu');

    await engine.handleMessage(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: 'hello',
      messageId: 'm1',
    } as any, provider);

    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.editMessage).not.toHaveBeenCalled();
    const sent = adapter.send.mock.calls[0][0];
    expect(sent.text).toContain('Hello');
    expect(sent.text).toContain('**Title**');
    expect(sent.text).toContain('Body');
    expect(sent.text).toContain('🖥️ Bash ×1');
    expect(sent.text).toContain('📊 1/1 tok');
  });

  it('normalizes Feishu streaming updates before sending card content', async () => {
    const store = createStore();
    const { provider } = createProvider([
      { kind: 'text_delta', text: 'Hello\n## Title\nBody' },
      { kind: 'query_result', sessionId: 'sdk-1', isError: false, usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    initBridgeContext({
      defaultWorkdir,
      store: store as any,
      llm: provider,
      permissions: {} as any,
      core: {} as any,
    });

    const state = createState();
    const router = createRouter('feishu');
    const permissions = createPermissions();
    const engine = new SDKEngine(state, router, permissions);
    const adapter = createMockAdapter('feishu');

    await engine.handleMessage(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: 'hello',
      messageId: 'm1',
    } as any, provider);

    const sent = adapter.send.mock.calls[0][0];
    expect(sent.text).toContain('Hello');
    expect(sent.text).toContain('**Title**');
    expect(sent.text).toContain('Body');
    expect(sent.text).not.toContain('## Title');
  });
});
