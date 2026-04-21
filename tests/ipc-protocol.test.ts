import { describe, it, expectTypeOf } from 'vitest';
import type { IPCRequest, IPCResponse } from '../src/ipc-protocol.js';

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
