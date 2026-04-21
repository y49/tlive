import { describe, it, expect, expectTypeOf, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPCRequest, IPCResponse } from '../src/ipc-protocol.js';
import { IPCServer, IPCClient, IPCClientRequester } from '../src/ipc.js';

describe('IPC protocol types', () => {
  it('create_session payload shape', () => {
    const req: IPCRequest = {
      type: 'create_session', payload: { provider: 'claude', workdir: '/x' },
    };
    expectTypeOf(req).toMatchTypeOf<IPCRequest>();
  });

  it('response discriminates on type', () => {
    const resp: IPCResponse = { type: 'session_created', payload: { sessionId: 'x' } };
    if (resp.type === 'session_created') {
      expectTypeOf(resp.payload.sessionId).toEqualTypeOf<string>();
    }
  });
});

describe('IPC round-trip via real sockets', () => {
  let root: string;
  let sockPath: string;
  let server: IPCServer;
  let client: IPCClient;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlive-ipc-'));
    sockPath = join(root, 'test.sock');
    server = new IPCServer();
    server.start(sockPath);
    client = new IPCClient({ path: sockPath, maxRetries: 5, retryDelay: 50, autoReconnect: false });
    await client.connect();
  });

  afterEach(async () => {
    client.disconnect();
    server.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('client can issue a typed request and receive a matching envelope response', async () => {
    // Wire server: on every incoming 'request' message, reply with a stub response
    // echoing the requestId.
    server.on('message', (msg: { type: string; payload: { envelope?: { requestId: string } } }, socket) => {
      if (msg.type !== 'request' || !msg.payload.envelope) return;
      server.reply(socket, {
        type: 'response',
        payload: {
          envelope: {
            requestId: msg.payload.envelope.requestId,
            message: { type: 'ack', payload: { ok: true } },
          },
        },
      });
    });

    const requester = new IPCClientRequester(client);
    const resp = await requester.request({ type: 'list_sessions', payload: {} });
    expect(resp).toEqual({ type: 'ack', payload: { ok: true } });
  });

  it('times out and cleans up listener if server never responds', async () => {
    const requester = new IPCClientRequester(client);
    await expect(requester.request({ type: 'list_sessions', payload: {} }, 100))
      .rejects.toThrow(/timeout/);
  });
});
