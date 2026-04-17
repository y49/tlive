import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodexAppServerClient } from '../client.js';

// In-memory transport double — records outgoing, replays incoming
class FakeTransport {
  messageHandlers: Array<(m: unknown) => void> = [];
  errorHandlers: Array<(e: Error) => void> = [];
  exitHandlers: Array<(e: { code: number | null; signal: string | null }) => void> = [];
  sent: unknown[] = [];
  onMessage(cb: (m: unknown) => void) { this.messageHandlers.push(cb); }
  onError(cb: (e: Error) => void) { this.errorHandlers.push(cb); }
  onExit(cb: (e: { code: number | null; signal: string | null }) => void) { this.exitHandlers.push(cb); }
  sendMessage(m: unknown) { this.sent.push(m); }
  async close() { return { code: 0, signal: null }; }
  // Test helpers
  receive(m: unknown) { this.messageHandlers.forEach(h => h(m)); }
}

describe('CodexAppServerClient', () => {
  let transport: FakeTransport;
  let client: CodexAppServerClient;

  beforeEach(() => {
    transport = new FakeTransport();
    client = new CodexAppServerClient(transport as any);
  });

  it('initialize() sends initialize request and records state', async () => {
    const initPromise = client.initialize({ capabilities: {} });
    expect(transport.sent).toHaveLength(1);
    const sent = transport.sent[0] as any;
    expect(sent.method).toBe('initialize');
    expect(sent.id).toBeDefined();
    expect(sent.params).toEqual({ capabilities: {} });
    // Server replies
    transport.receive({ id: sent.id, result: { capabilities: {} } });
    await initPromise;
  });

  it('request() throws if called before initialize()', async () => {
    await expect(client.request('thread/start', {})).rejects.toThrow(/initialize/i);
  });

  it('request() correlates response by id', async () => {
    await initialize(client, transport);
    const promise = client.request<{ x: number }, { y: number }>('my/method', { x: 1 });
    const sent = transport.sent[1] as any;
    expect(sent.method).toBe('my/method');
    expect(sent.params).toEqual({ x: 1 });
    transport.receive({ id: sent.id, result: { y: 42 } });
    const result = await promise;
    expect(result).toEqual({ y: 42 });
  });

  it('request() rejects on JSON-RPC error response', async () => {
    await initialize(client, transport);
    const promise = client.request('bad/method', {});
    const sent = transport.sent[1] as any;
    transport.receive({ id: sent.id, error: { code: -32601, message: 'Method not found' } });
    await expect(promise).rejects.toThrow(/method not found/i);
  });

  it('request() with two concurrent calls correlates correctly even if responses arrive out of order', async () => {
    await initialize(client, transport);
    const p1 = client.request('m1', {});
    const p2 = client.request('m2', {});
    const sent1 = transport.sent[1] as any;
    const sent2 = transport.sent[2] as any;
    // Reply to second request first
    transport.receive({ id: sent2.id, result: 'r2' });
    transport.receive({ id: sent1.id, result: 'r1' });
    expect(await p1).toBe('r1');
    expect(await p2).toBe('r2');
  });

  it('request() times out and rejects', async () => {
    vi.useFakeTimers();
    await initialize(client, transport);
    const promise = client.request('slow', {}, 100);
    vi.advanceTimersByTime(200);
    await expect(promise).rejects.toThrow(/timeout/i);
    vi.useRealTimers();
  });

  it('notify() sends message without id and does not await response', () => {
    client.notify('some/notification', { x: 1 });
    expect(transport.sent).toHaveLength(1);
    const sent = transport.sent[0] as any;
    expect(sent.method).toBe('some/notification');
    expect(sent.params).toEqual({ x: 1 });
    expect(sent.id).toBeUndefined();
  });

  it('incoming notification is dispatched to onNotification handlers', async () => {
    await initialize(client, transport);
    const received: Array<{ method: string; params: unknown }> = [];
    client.onNotification('thread/started', (p) => received.push({ method: 'thread/started', params: p }));
    transport.receive({ method: 'thread/started', params: { threadId: 't1' } });
    expect(received).toEqual([{ method: 'thread/started', params: { threadId: 't1' } }]);
  });

  it('unknown response id is dropped with warn', async () => {
    await initialize(client, transport);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport.receive({ id: 9999, result: 'orphan' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('9999'));
    warnSpy.mockRestore();
  });
});

// Helper: complete initialize handshake
async function initialize(client: CodexAppServerClient, transport: FakeTransport): Promise<void> {
  const promise = client.initialize({ capabilities: {} });
  const sent = transport.sent[0] as any;
  transport.receive({ id: sent.id, result: {} });
  await promise;
}
