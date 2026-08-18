import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { connectCodexRpc, COMPANION_CLIENT_NAME, NON_ORIGINATING_CLIENT_NAMES } from '../rpc';

class FakeSock extends EventEmitter {
  sent: any[] = [];
  readyState = 1;
  closed = false;
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; this.emit('close'); }
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
    // clientInfo.version should match semantic versioning, not hardcoded '0.0.0'
    expect(sock.sent[0].params.clientInfo.version).toMatch(/^\d+\.\d+\.\d+/);
    sock.reply({ jsonrpc: '2.0', id: sock.sent[0].id, result: { userAgent: 'x' } });
    const rpc = await p;
    expect(sock.sent[1]).toMatchObject({ method: 'initialized' });
    expect(rpc.call).toBeTypeOf('function');
  });

  it('gives up on a socket that connects but never completes the handshake', async () => {
    // Found by running a real daemon against a stand-in that accepted the
    // connection and spoke no WebSocket. `open` never fires, so `initialize` is
    // never sent and its 10s timeout is never even armed: the promise settles
    // neither way, connectLoop stays parked in its await forever, and there is
    // no log, no retry and no reconnect - while custody still sees a listening
    // socket and reports the companion as running. A hung or wedged app-server
    // does the same thing.
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const { sock, p } = boot({ onClose });
      const settled = expect(p).rejects.toThrow(/handshake/i);
      await vi.advanceTimersByTimeAsync(31_000);
      await settled;
      expect(sock.closed).toBe(true);
      expect(onClose).not.toHaveBeenCalled(); // one report, as with any other handshake failure
    } finally { vi.useRealTimers(); }
  });

  it('identifies as a non-originating client so it cannot hijack the process originator', () => {
    const { sock } = boot();
    sock.open();
    expect(sock.sent[0].params.clientInfo.name).toBe(COMPANION_CLIENT_NAME);
    // The exemption is a hardcoded allowlist upstream; anything else silently
    // makes every thread in this app-server — including the user's own TUI
    // threads — report `originator: <us>`.
    expect(NON_ORIGINATING_CLIENT_NAMES).toContain(COMPANION_CLIENT_NAME);
    // Identity still travels, just not as the process-global originator.
    expect(sock.sent[0].params.clientInfo.title).toMatch(/tlive/);
  });

  it('reports the effective originator so a lost exemption cannot pass silently', async () => {
    const { sock, p } = boot();
    sock.open();
    sock.reply({ jsonrpc: '2.0', id: sock.sent[0].id, result: { userAgent: 'codex-tui/0.147.0 (Arch Linux; x86_64) codex_cli_rs' } });
    expect((await p).effectiveOriginator).toBe('codex-tui');
  });

  it('closes the socket when the handshake fails, and reports the failure exactly once', async () => {
    const onClose = vi.fn();
    const { sock, p } = boot({ onClose });
    sock.open();
    sock.reply({ jsonrpc: '2.0', id: sock.sent[0].id, error: { message: 'Already initialized' } });
    await expect(p).rejects.toThrow(/Already initialized/);
    // Leaked handshakes are not hypothetical: a socket left open keeps its
    // message handler installed, so a connection the caller believes is dead
    // goes on delivering events and approval requests.
    expect(sock.closed).toBe(true);
    // The rejected promise is the ONLY failure report. Firing onClose as well
    // gives the caller two reconnect triggers for one failure, which is how the
    // daemon ended up holding two live connections to one app-server.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not report a pre-open connect error through onClose either', async () => {
    const onClose = vi.fn();
    const { sock, p } = boot({ onClose });
    sock.emit('error', new Error('connect ENOENT'));
    sock.close();
    await expect(p).rejects.toThrow(/ENOENT/);
    expect(onClose).not.toHaveBeenCalled();
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
      // Attach the rejection assertion BEFORE advancing timers — otherwise the
      // timeout rejection fires before `.rejects` attaches, producing an
      // unhandled rejection that makes vitest exit 1 despite all tests passing.
      const r = expect(c).rejects.toThrow(/timeout/);
      await vi.advanceTimersByTimeAsync(1100);
      await r;
      sock.close();
      expect(onClose).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
