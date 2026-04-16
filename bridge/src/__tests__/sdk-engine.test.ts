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
    const store = {
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

    const liveSession = {
      isAlive: true,
      isTurnActive: false,
      startTurn: vi.fn(() => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ kind: 'query_result', sessionId: 'sdk-1', isError: false, usage: { inputTokens: 1, outputTokens: 1 } });
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

    initBridgeContext({
      defaultWorkdir,
      store: store as any,
      llm: provider,
      permissions: {} as any,
      core: {} as any,
    });

    const state = {
      checkAndUpdateLastActive: vi.fn().mockReturnValue(false),
      clearThread: vi.fn(),
      clearSessionWhitelist: vi.fn(),
      stateKey: vi.fn().mockImplementation((ct: string, id: string) => `${ct}:${id}`),
      getThread: vi.fn().mockReturnValue(undefined),
      getPermMode: vi.fn().mockReturnValue('off'),
      getEffort: vi.fn().mockReturnValue(undefined),
      getModel: vi.fn().mockReturnValue(undefined),
      getRuntime: vi.fn().mockReturnValue(undefined),
    } as any;

    const router = {
      resolve: vi.fn().mockResolvedValue({ channelType: 'telegram', chatId: 'c1', sessionId: 's1', createdAt: '' }),
      rebind: vi.fn(),
    } as any;

    const permissions = {
      clearSessionWhitelist: vi.fn(),
      isToolAllowed: vi.fn().mockReturnValue(false),
      setPendingSdkPerm: vi.fn(),
      clearPendingSdkPerm: vi.fn(),
      getGateway: vi.fn().mockReturnValue({ waitFor: vi.fn(), isPending: vi.fn().mockReturnValue(false) }),
      trackPermissionMessage: vi.fn(),
      storeQuestionData: vi.fn(),
    } as any;

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
