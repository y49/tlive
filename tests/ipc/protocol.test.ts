// tests/ipc/protocol.test.ts
//
// Envelope framing, line parser, request/response union shape.

import { describe, it, expect } from 'vitest';
import {
  encodeFrame, createLineFramer, type IpcRequest, type IpcResponse,
} from '../../src/ipc/protocol.js';

describe('encodeFrame / createLineFramer', () => {
  it('round-trips a request envelope', () => {
    const env = { requestId: 'r1', message: { kind: 'daemon.status' } as const satisfies { kind: 'daemon.status' } };
    const line = encodeFrame(env);
    expect(line.endsWith('\n')).toBe(true);
    let seen: unknown;
    const framer = createLineFramer((e) => { seen = e; });
    framer.push(line);
    expect(seen).toEqual(env);
  });

  it('handles partial chunks and multiple frames', () => {
    const received: unknown[] = [];
    const framer = createLineFramer((e) => received.push(e));
    const a = encodeFrame({ requestId: 'a', message: { kind: 'session.list' } });
    const b = encodeFrame({ requestId: 'b', message: { kind: 'daemon.status' } });
    // split between "a\n" and "part+b"
    const combined = a + b;
    framer.push(combined.slice(0, 10));
    framer.push(combined.slice(10));
    expect(received).toHaveLength(2);
  });

  it('drops malformed lines silently', () => {
    const received: unknown[] = [];
    const framer = createLineFramer((e) => received.push(e));
    framer.push('not-json\n');
    framer.push(encodeFrame({ requestId: 'r', message: { kind: 'daemon.status' } }));
    expect(received).toHaveLength(1);
  });

  it('IpcRequest union discriminates on kind', () => {
    const r: IpcRequest = { kind: 'session.stop', alias: 'abc' };
    if (r.kind === 'session.stop') expect(r.alias).toBe('abc');
  });

  it('IpcResponse session.stopped has sdkSessionId', () => {
    const r: IpcResponse = { kind: 'session.stopped', sdkSessionId: 'sid-x' };
    if (r.kind === 'session.stopped') expect(r.sdkSessionId).toBe('sid-x');
  });
});
