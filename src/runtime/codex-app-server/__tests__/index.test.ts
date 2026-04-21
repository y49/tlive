import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { CodexAppServerProvider, __testing_resetBinaryDetectCache } from '../index.js';

describe('CodexAppServerProvider — binary detection + lifecycle', () => {
  beforeEach(() => {
    __testing_resetBinaryDetectCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isAvailable() returns false when codex binary not in PATH', async () => {
    const provider = new CodexAppServerProvider({
      execFile: vi.fn().mockRejectedValue(new Error('spawn ENOENT')),
    });
    expect(await provider.isAvailable()).toBe(false);
  });

  it('isAvailable() returns false when codex version < 0.121.0', async () => {
    const provider = new CodexAppServerProvider({
      execFile: vi.fn().mockResolvedValue({ stdout: 'codex-cli 0.120.0\n', stderr: '' }),
    });
    expect(await provider.isAvailable()).toBe(false);
  });

  it('isAvailable() returns true when codex version >= 0.121.0', async () => {
    const provider = new CodexAppServerProvider({
      execFile: vi.fn().mockResolvedValue({ stdout: 'codex-cli 0.121.5\n', stderr: '' }),
    });
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable() result is cached after first call', async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: 'codex-cli 0.121.0\n', stderr: '' });
    const provider = new CodexAppServerProvider({ execFile });
    await provider.isAvailable();
    await provider.isAvailable();
    await provider.isAvailable();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('capabilities() returns provider capabilities for codex flavor', () => {
    const provider = new CodexAppServerProvider({ execFile: vi.fn() });
    const caps = provider.capabilities();
    expect(caps).toBeDefined();
    expect(typeof caps).toBe('object');
  });
});

describe('CodexAppServerProvider — streamChat', () => {
  beforeEach(() => {
    __testing_resetBinaryDetectCache();
  });

  it('streamChat emits status → query_result for a trivial successful turn', async () => {
    const { provider, replyFromServer, sentToServer } = buildMockedProvider();
    const result = provider.streamChat({
      prompt: 'hi',
      workingDirectory: '/tmp',
      sessionId: undefined,
    });
    await flushMicro();
    const initMsg = sentToServer.find(m => m.method === 'initialize');
    expect(initMsg).toBeDefined();
    replyFromServer({ id: initMsg.id, result: { capabilities: {} } });
    await flushMicro();
    const threadMsg = sentToServer.find(m => m.method === 'thread/start');
    expect(threadMsg).toBeDefined();
    replyFromServer({ id: threadMsg.id, result: { thread: { id: 'thread-abc' } } });
    replyFromServer({ method: 'thread/started', params: { thread: { id: 'thread-abc' } } });
    await flushMicro();
    const turnMsg = sentToServer.find(m => m.method === 'turn/start');
    expect(turnMsg).toBeDefined();
    replyFromServer({ id: turnMsg.id, result: { turn: { id: 'turn-1' } } });
    replyFromServer({ method: 'turn/started', params: { threadId: 'thread-abc', turn: { id: 'turn-1' } } });
    replyFromServer({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-abc', turnId: 'turn-1',
        tokenUsage: {
          total: { totalTokens: 50, inputTokens: 40, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
          last:  { totalTokens: 50, inputTokens: 40, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
          modelContextWindow: null,
        },
      },
    });
    replyFromServer({
      method: 'turn/completed',
      params: { threadId: 'thread-abc', turn: { id: 'turn-1', status: 'completed', items: [] } },
    });
    const events = await consumeStream(result.stream, 5);
    const kinds = events.map(e => e.kind);
    expect(kinds).toContain('status');
    expect(kinds).toContain('query_result');
    const qr = events.find(e => e.kind === 'query_result') as any;
    expect(qr.sessionId).toBe('thread-abc');
    expect(qr.usage).toMatchObject({ inputTokens: 40, outputTokens: 10 });
  });

  it('streamChat interrupt sends turn/interrupt RPC', async () => {
    const { provider, replyFromServer, sentToServer } = buildMockedProvider();
    const result = provider.streamChat({
      prompt: 'hi',
      workingDirectory: '/tmp',
      sessionId: undefined,
    });
    await flushMicro();
    const initMsg = sentToServer.find(m => m.method === 'initialize');
    replyFromServer({ id: initMsg.id, result: { capabilities: {} } });
    await flushMicro();
    const threadMsg = sentToServer.find(m => m.method === 'thread/start');
    replyFromServer({ id: threadMsg.id, result: { thread: { id: 'thread-abc' } } });
    replyFromServer({ method: 'thread/started', params: { thread: { id: 'thread-abc' } } });
    await flushMicro();
    const turnMsg = sentToServer.find(m => m.method === 'turn/start');
    replyFromServer({ id: turnMsg.id, result: { turn: { id: 'turn-9' } } });
    replyFromServer({ method: 'turn/started', params: { threadId: 'thread-abc', turn: { id: 'turn-9' } } });
    await flushMicro();
    await result.controls!.interrupt!();
    const interruptMsg = sentToServer.find(m => m.method === 'turn/interrupt');
    expect(interruptMsg).toBeDefined();
    expect((interruptMsg as any).params).toMatchObject({ threadId: 'thread-abc', turnId: 'turn-9' });
  });

  it('streamChat with existing sessionId uses thread/resume not thread/start', async () => {
    const { provider, replyFromServer, sentToServer } = buildMockedProvider();
    const result = provider.streamChat({
      prompt: 'continue',
      workingDirectory: '/tmp',
      sessionId: 'existing-thread',
    });
    await flushMicro();
    const initMsg = sentToServer.find(m => m.method === 'initialize');
    replyFromServer({ id: initMsg.id, result: { capabilities: {} } });
    await flushMicro();
    expect(sentToServer.some(m => m.method === 'thread/resume')).toBe(true);
    expect(sentToServer.some(m => m.method === 'thread/start')).toBe(false);
    const reader = result.stream.getReader();
    reader.cancel();
  });

  it('streamChat emits error event when subprocess exits mid-turn', async () => {
    const { provider, replyFromServer, sentToServer, triggerExit } = buildMockedProvider();
    const result = provider.streamChat({ prompt: 'hi', workingDirectory: '/tmp', sessionId: undefined });
    await flushMicro();
    replyFromServer({ id: sentToServer[0].id, result: { capabilities: {} } });
    await flushMicro();
    replyFromServer({ id: sentToServer.find(m => m.method === 'thread/start')!.id, result: { thread: { id: 't' } } });
    replyFromServer({ method: 'thread/started', params: { thread: { id: 't' } } });
    await flushMicro();
    replyFromServer({ id: sentToServer.find(m => m.method === 'turn/start')!.id, result: { turn: { id: 'tr' } } });
    triggerExit(1, null);
    const events = await consumeStream(result.stream, 5, 300);
    expect(events.some(e => e.kind === 'error')).toBe(true);
  });
});

// --- Test helpers ---
async function flushMicro() {
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

async function consumeStream<T>(stream: ReadableStream<T>, max: number, timeoutMs = 500): Promise<T[]> {
  const events: T[] = [];
  const reader = stream.getReader();
  const timer = setTimeout(() => reader.cancel(), timeoutMs);
  try {
    while (events.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return events;
}

function buildMockedProvider() {
  const stdout = new Readable({ read() {} });
  const stdinWrites: Buffer[] = [];
  const stdin = {
    write: (chunk: Buffer | string) => { stdinWrites.push(Buffer.from(chunk as any)); return true; },
    end: () => {},
    on: () => {},
  };
  const listeners: Record<string, Array<(...a: any[]) => void>> = { exit: [], error: [] };
  const child: any = {
    stdout, stdin,
    kill: vi.fn(),
    on: (ev: string, cb: any) => { (listeners[ev] ??= []).push(cb); },
    once: (ev: string, cb: any) => { (listeners[ev] ??= []).push(cb); },
    emit: (ev: string, ...args: any[]) => { (listeners[ev] ?? []).forEach(l => l(...args)); },
  };
  const provider = new CodexAppServerProvider({
    execFile: vi.fn().mockResolvedValue({ stdout: 'codex-cli 0.121.0\n', stderr: '' }),
    spawnSubprocess: () => child,
  } as any);
  const sentToServer: any[] = [];
  const parseWrites = () => {
    const combined = Buffer.concat(stdinWrites).toString('utf8');
    stdinWrites.length = 0;
    for (const line of combined.split('\n')) {
      if (line.trim().length > 0) {
        try { sentToServer.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    }
  };
  const origWrite = stdin.write;
  (stdin as any).write = (chunk: Buffer | string) => { const r = origWrite(chunk); parseWrites(); return r; };
  const replyFromServer = (msg: unknown) => stdout.push(JSON.stringify(msg) + '\n');
  const triggerExit = (code: number | null, signal: string | null) => child.emit('exit', code, signal);
  return { provider, replyFromServer, sentToServer, triggerExit };
}
