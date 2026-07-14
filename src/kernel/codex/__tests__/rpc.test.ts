import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { connectCodexRpc } from '../rpc';

class FakeSock extends EventEmitter {
  sent: any[] = [];
  readyState = 1;
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.emit('close'); }
  open() { this.emit('open'); }
  reply(obj: unknown) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

function boot(events = {} as any) {
  const sock = new FakeSock();
  const p = connectCodexRpc({
    sockPath: '/nowhere.sock',
    events: { onNotify: vi.fn(), onServerRequest: vi.fn(), onClose: vi.fn(), ...events },
    makeSocket: () => sock as any,
  });
  return { sock, p };
}

describe('connectCodexRpc handshake', () => {
  it('sends initialize then initialized, resolves client', async () => {
    const { sock, p } = boot();
    sock.open();
    // first outbound message is initialize with experimentalApi
    expect(sock.sent[0]).toMatchObject({ method: 'initialize', params: { capabilities: { experimentalApi: true } } });
    sock.reply({ jsonrpc: '2.0', id: sock.sent[0].id, result: { userAgent: 'x' } });
    const rpc = await p;
    expect(sock.sent[1]).toMatchObject({ method: 'initialized' });
    expect(rpc.call).toBeTypeOf('function');
  });
});

describe('call/notify/dispatch', () => {
  async function live(events = {} as any) {
    const { sock, p } = boot(events);
    sock.open();
    sock.reply({ jsonrpc: '2.0', id: sock.sent[0].id, result: {} });
    return { sock, rpc: await p };
  }
  it('correlates responses and rejects on error result', async () => {
    const { sock, rpc } = await live();
    const c = rpc.call('thread/loaded/list', {});
    const req = sock.sent.at(-1);
    sock.reply({ jsonrpc: '2.0', id: req.id, result: { data: ['t1'] } });
    expect(await c).toEqual({ data: ['t1'] });
    const c2 = rpc.call('thread/resume', { threadId: 'x' });
    sock.reply({ jsonrpc: '2.0', id: sock.sent.at(-1).id, error: { code: -32600, message: 'no rollout' } });
    await expect(c2).rejects.toThrow(/no rollout/);
  });
  it('routes notifications and server-requests; respond() sends a result frame once', async () => {
    const onNotify = vi.fn();
    const reqs: any[] = [];
    const { sock } = await live({
      onNotify,
      onServerRequest: (id: any, method: string, params: any, respond: (r: unknown) => void) => {
        reqs.push({ id, method, params }); respond({ decision: 'accept' }); respond({ decision: 'decline' });
      },
    });
    sock.reply({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 't' } });
    expect(onNotify).toHaveBeenCalledWith('turn/started', { threadId: 't' });
    sock.reply({ jsonrpc: '2.0', id: 77, method: 'item/commandExecution/requestApproval', params: { itemId: 'i1' } });
    expect(reqs[0]).toMatchObject({ id: 77, method: 'item/commandExecution/requestApproval' });
    const responses = sock.sent.filter((m: any) => m.id === 77 && m.result);
    expect(responses).toHaveLength(1); // second respond() is a no-op
    expect(responses[0].result).toEqual({ decision: 'accept' });
  });
  it('call times out and onClose fires on socket close', async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const { sock, rpc } = await live({ onClose });
      const c = rpc.call('x', {}, 1000);
      await vi.advanceTimersByTimeAsync(1100);
      await expect(c).rejects.toThrow(/timeout/);
      sock.close();
      expect(onClose).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
