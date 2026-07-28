import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { guardWindowsConinSocket } from '../win-conin-guard.js';

/** Shaped like node-pty's WindowsTerminal: a private _agent exposing inSocket. */
const fakeWinPty = (): { pty: IPty; inSocket: EventEmitter } => {
  const inSocket = new EventEmitter();
  return { pty: { _agent: { inSocket } } as unknown as IPty, inSocket };
};

describe('guardWindowsConinSocket', () => {
  it('attaches an error listener to the conin socket on win32', () => {
    const { pty, inSocket } = fakeWinPty();
    expect(guardWindowsConinSocket(pty, 'win32')).toBe(true);
    expect(inSocket.listenerCount('error')).toBe(1);
  });

  it('swallows a conin error instead of letting it become an uncaught exception', () => {
    const { pty, inSocket } = fakeWinPty();
    guardWindowsConinSocket(pty, 'win32');
    // Without a listener, EventEmitter rethrows. With one, this is a no-op.
    expect(() => inSocket.emit('error', Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' }))).not.toThrow();
  });

  it('does nothing on non-win32 platforms', () => {
    const { pty, inSocket } = fakeWinPty();
    expect(guardWindowsConinSocket(pty, 'linux')).toBe(false);
    expect(inSocket.listenerCount('error')).toBe(0);
  });

  it('reports false rather than throwing when node-pty no longer exposes the socket', () => {
    // Future-proofing: an upstream rename must degrade to a no-op, not a crash.
    expect(guardWindowsConinSocket({} as IPty, 'win32')).toBe(false);
    expect(guardWindowsConinSocket({ _agent: {} } as unknown as IPty, 'win32')).toBe(false);
  });
});
