import { describe, it, expect, vi } from 'vitest';
import { IPCSessionHandler } from '../engine/ipc-session-handler.js';

function fakeIpc() {
  let handler: ((msg: unknown, socket: unknown) => void) | null = null;
  const replies: unknown[] = [];
  return {
    on: (_: string, h: (msg: unknown, socket: unknown) => void) => { handler = h; },
    reply: (_sock: unknown, msg: unknown) => replies.push(msg),
    fire: (msg: unknown) => handler?.(msg, {}),
    replies,
  };
}

function fakeManager() {
  return {
    create: vi.fn(async ({ workdir }: { workdir: string }) => ({ id: 'sid-' + workdir })),
    get: vi.fn(() => null),
    list: vi.fn(() => []),
    stop: vi.fn(async () => {}),
    resume: vi.fn(async () => null),
  };
}

function fakeBroker() { return { resolve: vi.fn(() => true) }; }
function fakeWsMgr() { return { ensureDefault: vi.fn(() => ({ name: 'ws' })) }; }

describe('IPCSessionHandler', () => {
  it('dispatches create_session and replies with session_created', async () => {
    const ipc = fakeIpc();
    const mgr = fakeManager();
    const h = new IPCSessionHandler(ipc as any, mgr as any, fakeBroker() as any, fakeWsMgr() as any);
    h.start();
    ipc.fire({
      type: 'request',
      payload: { envelope: { requestId: 'r1', message: {
        type: 'create_session', payload: { provider: 'claude', workdir: '/x' },
      } } },
    });
    await new Promise((r) => setTimeout(r, 0));
    const reply = ipc.replies[0] as any;
    expect(reply.payload.envelope.message.type).toBe('session_created');
  });

  it('returns error for unknown session in send_input', async () => {
    const ipc = fakeIpc();
    const h = new IPCSessionHandler(ipc as any, fakeManager() as any, fakeBroker() as any, fakeWsMgr() as any);
    h.start();
    ipc.fire({
      type: 'request',
      payload: { envelope: { requestId: 'r2', message: {
        type: 'send_input', payload: { sessionId: 'nope', text: 'hi' },
      } } },
    });
    await new Promise((r) => setTimeout(r, 0));
    const reply = ipc.replies[0] as any;
    expect(reply.payload.envelope.message.type).toBe('error');
  });
});
