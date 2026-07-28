//
// Containment for an upstream node-pty defect on Windows.
//
// node-pty opens two pipes to the ConPTY. The read side (conout) gets an
// 'error' listener in windowsTerminal.ts:90; the write side (conin) is
// constructed in windowsPtyAgent.ts:79 with none. A net.Socket without an
// 'error' listener turns any emitted error into an uncaught exception, so a
// failing pty write takes the whole daemon down. Two triggers reach it: EAGAIN
// when conin's buffer fills under backpressure, and a write racing kill()'s
// _inSocket.destroy() (windowsPtyAgent.ts:176).
//
// Reaching through the private _agent is deliberate — Terminal.on() forwards to
// the conout socket, so there is no public route to conin. Verified against
// node-pty@1.2.0-beta.14. Delete this once an upstream release carries the
// listener; re-check the internal shape on every node-pty bump.

import type { IPty } from 'node-pty';

interface ErrorEmitter { on(event: 'error', listener: (err: Error) => void): unknown }
interface WindowsPtyInternals { _agent?: { inSocket?: ErrorEmitter } }

/** Returns whether a listener was attached (false on non-win32, or if the shape is gone). */
export function guardWindowsConinSocket(pty: IPty, platform: string = process.platform): boolean {
  if (platform !== 'win32') return false;
  const sock = (pty as unknown as WindowsPtyInternals)._agent?.inSocket;
  if (!sock || typeof sock.on !== 'function') return false;
  // A failed write is not fatal: the pty's real lifecycle is driven by onExit.
  sock.on('error', () => { /* swallowed — see the note above */ });
  return true;
}
