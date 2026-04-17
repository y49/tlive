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

  it('onCommandExecutionApproval handler receives params and sends response', async () => {
    await initialize(client, transport);
    client.onCommandExecutionApproval(async (params) => {
      expect(params).toMatchObject({ threadId: 't1', command: 'ls' });
      return { decision: 'accept' as const };
    });
    // Server sends request
    const reqId = 42;
    transport.receive({
      id: reqId,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't1', turnId: 'tr1', itemId: 'i1', command: 'ls', cwd: '/tmp' },
    });
    // Wait for handler to respond
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    const sent = transport.sent.find((s: any) => s.id === reqId);
    expect(sent).toMatchObject({ id: 42, result: { decision: 'accept' } });
  });

  it('onFileChangeApproval handler wired correctly', async () => {
    await initialize(client, transport);
    client.onFileChangeApproval(async () => ({ decision: 'decline' as const }));
    transport.receive({
      id: 50,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 't1', turnId: 'tr1', itemId: 'i2' },
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(transport.sent.find((s: any) => s.id === 50)).toMatchObject({ id: 50, result: { decision: 'decline' } });
  });

  it('onMcpElicitation handler wired correctly', async () => {
    await initialize(client, transport);
    client.onMcpElicitation(async () => ({ action: 'decline' as const, content: null }));
    transport.receive({
      id: 51,
      method: 'mcpServer/elicitation/request',
      params: { threadId: 't1', serverName: 'test' },
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(transport.sent.find((s: any) => s.id === 51)).toMatchObject({
      id: 51,
      result: { action: 'decline', content: null },
    });
  });

  it('server request with no registered handler → method_not_found error', async () => {
    await initialize(client, transport);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport.receive({
      id: 77,
      method: 'unknown/method',
      params: {},
    });
    await new Promise(r => setImmediate(r));
    const sent = transport.sent.find((s: any) => s.id === 77);
    expect(sent).toMatchObject({ id: 77, error: { code: -32601 } });
    warnSpy.mockRestore();
  });

  it('server request handler that throws → error response sent back', async () => {
    await initialize(client, transport);
    client.onCommandExecutionApproval(async () => { throw new Error('boom'); });
    transport.receive({
      id: 88,
      method: 'item/commandExecution/requestApproval',
      params: {},
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    const sent = transport.sent.find((s: any) => s.id === 88);
    expect(sent).toMatchObject({ id: 88, error: { message: expect.stringContaining('boom') } });
  });

  it('close() rejects all pending requests', async () => {
    await initialize(client, transport);
    const p1 = client.request('m1', {});
    const p2 = client.request('m2', {});
    await client.close();
    await expect(p1).rejects.toThrow(/closed/i);
    await expect(p2).rejects.toThrow(/closed/i);
  });
});

// Helper: complete initialize handshake
async function initialize(client: CodexAppServerClient, transport: FakeTransport): Promise<void> {
  const promise = client.initialize({ capabilities: {} });
  const sent = transport.sent[0] as any;
  transport.receive({ id: sent.id, result: {} });
  await promise;
}
