import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationEngine } from '../engine/conversation.js';
import { initBridgeContext } from '../context.js';
import type { CanonicalEvent } from '../messages/schema.js';

// Mock store
function createMockStore() {
  return {
    getSession: vi.fn().mockResolvedValue({ id: 's1', workingDirectory: '/tmp', createdAt: '' }),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    acquireLock: vi.fn().mockResolvedValue(true),
    renewLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    // other methods as stubs
    saveSession: vi.fn(), deleteSession: vi.fn(), listSessions: vi.fn(),
    getBinding: vi.fn(), saveBinding: vi.fn(), deleteBinding: vi.fn(), listBindings: vi.fn(),
    isDuplicate: vi.fn(), markProcessed: vi.fn(),
  };
}

// Mock LLM that emits controlled CanonicalEvent objects
function createMockLLM(events: CanonicalEvent[]) {
  return {
    streamChat: () => ({
      stream: new ReadableStream<CanonicalEvent>({
        start(controller) {
          for (const event of events) {
            controller.enqueue(event);
          }
          controller.close();
        }
      }),
      controls: undefined,
    })
  };
}

describe('ConversationEngine', () => {
  let engine: ConversationEngine;
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    mockStore = createMockStore();
    const mockLLM = createMockLLM([
      { kind: 'text_delta', text: 'Hello ' },
      { kind: 'text_delta', text: 'world' },
      { kind: 'query_result', sessionId: 's1', isError: false, usage: { inputTokens: 10, outputTokens: 5 } },
    ]);

    initBridgeContext({
      defaultWorkdir: '/tmp',
      store: mockStore as any,
      llm: mockLLM as any,
      permissions: {} as any,
    });

    engine = new ConversationEngine();
  });

  it('processes message and returns full response', async () => {
    const result = await engine.processMessage({
      sessionId: 's1',
      text: 'hi',
    });
    expect(result.text).toBe('Hello world');
  });

  it('acquires and releases session lock', async () => {
    await engine.processMessage({ sessionId: 's1', text: 'hi' });
    expect(mockStore.acquireLock).toHaveBeenCalledWith('session:s1', expect.any(Number));
    expect(mockStore.releaseLock).toHaveBeenCalledWith('session:s1');
  });

  it('saves user and assistant messages', async () => {
    await engine.processMessage({ sessionId: 's1', text: 'hi' });
    expect(mockStore.saveMessage).toHaveBeenCalledTimes(2);
    // First call: user message
    expect(mockStore.saveMessage.mock.calls[0][1].role).toBe('user');
    // Second call: assistant message
    expect(mockStore.saveMessage.mock.calls[1][1].role).toBe('assistant');
  });

  it('calls onTextDelta for streaming', async () => {
    const deltas: string[] = [];
    await engine.processMessage({
      sessionId: 's1',
      text: 'hi',
      onTextDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(['Hello ', 'world']);
  });

  it('calls onQueryResult with usage', async () => {
    let resultData: any;
    await engine.processMessage({
      sessionId: 's1',
      text: 'hi',
      onQueryResult: (r) => { resultData = r; },
    });
    expect(resultData.usage.inputTokens).toBe(10);
  });

  it('releases lock even on error', async () => {
    const errorLLM = {
      streamChat: () => ({
        stream: new ReadableStream<CanonicalEvent>({
          start(controller) {
            controller.enqueue({ kind: 'error', message: 'boom' });
            controller.close();
          }
        }),
        controls: undefined,
      })
    };
    initBridgeContext({ defaultWorkdir: '/tmp', store: mockStore as any, llm: errorLLM as any, permissions: {} as any });
    engine = new ConversationEngine();

    await engine.processMessage({ sessionId: 's1', text: 'hi' });
    expect(mockStore.releaseLock).toHaveBeenCalled();
  });
});
