import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/ipc.js', () => {
  class FakeIPCClient {
    async connect() { return true; }
    disconnect() {}
    on() {} off() {} send() {}
  }
  class FakeRequester {
    constructor(public client: unknown) {}
    async request(req: { type: string; payload: { provider?: string } }) {
      const provider = req.payload.provider ?? 'unknown';
      return { type: 'session_created', payload: { sessionId: `sid-${provider}` } };
    }
  }
  return {
    IPCClient: FakeIPCClient,
    IPCClientRequester: FakeRequester,
    IPC_PATH: '/tmp/fake',
    IPC_PATH_V1: '/tmp/fake-v1',
  };
});

import { sendRequest } from '../../src/cli/ipc-client-lite.js';

describe('sendRequest', () => {
  it('forwards request and returns daemon response', async () => {
    const resp = await sendRequest({ type: 'create_session', payload: { provider: 'claude', workdir: '/x' } });
    expect(resp).toEqual({ type: 'session_created', payload: { sessionId: 'sid-claude' } });
  });

  it('forwards codex provider', async () => {
    const resp = await sendRequest({ type: 'create_session', payload: { provider: 'codex', workdir: '/x' } });
    expect(resp).toEqual({ type: 'session_created', payload: { sessionId: 'sid-codex' } });
  });
});
