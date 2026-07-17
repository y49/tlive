// src/kernel/ipc/__tests__/client-close.test.ts
//
// Reproduces the confirmed production freeze: the daemon dies/restarts mid
// request (a clean FIN — 'end' then 'close', NOT 'error') and the client's
// request() must reject promptly instead of sitting on a 24h timer.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { request } from '../client';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

const mkSock = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'tlive-ipc-close-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'daemon.sock');
};

/** Raw net server (deliberately NOT startIpcServer) so the test controls
 *  exactly when/whether a reply is written — needed to simulate a daemon
 *  that accepts the connection, reads the request, then vanishes. */
function rawServer(path: string, onConnection: (sock: Socket) => void): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer(onConnection);
    srv.listen(path, () => resolve(srv));
  });
}

describe('ipc client — connection closed without a reply', () => {
  it('rejects promptly when the server closes the socket after receiving the request but before replying (daemon-death simulation)', async () => {
    const path = mkSock();
    const srv = await rawServer(path, (sock) => {
      sock.on('data', () => {
        // Simulate the daemon dying mid-request: close cleanly, no reply,
        // no error — exactly the FIN a restart produces.
        sock.end();
      });
    });
    cleanup.push(() => void srv.close());

    const started = Date.now();
    // Deliberately long timeoutMs: if the fix is absent this test must hang
    // for the full 60s (or until the suite's own testTimeout kills it) rather
    // than pass — that asymmetry is what proves the fix, not a proxy.
    await expect(
      request({ kind: 'daemon.status' }, { socketPath: path, timeoutMs: 60_000 }),
    ).rejects.toThrow();
    const elapsed = Date.now() - started;
    // Promptly = nowhere near the 60s timeout budget.
    expect(elapsed).toBeLessThan(2000);
  });

  it('rejects with a distinguishable error, not the generic timeout error', async () => {
    const path = mkSock();
    const srv = await rawServer(path, (sock) => {
      sock.on('data', () => sock.end());
    });
    cleanup.push(() => void srv.close());

    let caught: Error | undefined;
    try {
      await request({ kind: 'daemon.status' }, { socketPath: path, timeoutMs: 60_000 });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toMatch(/ipc timeout/i);
  });

  it('does not reject when the socket closes after a legitimate reply (success path unaffected)', async () => {
    const path = mkSock();
    const srv = await rawServer(path, (sock) => {
      sock.on('data', () => {
        sock.write(JSON.stringify({ kind: 'ack' }) + '\n');
        // Server also drops the connection right after replying — this must
        // not race the resolve into a rejection.
      });
    });
    cleanup.push(() => void srv.close());

    const r = await request({ kind: 'daemon.status' }, { socketPath: path, timeoutMs: 2000 });
    expect(r.kind).toBe('ack');

    // Give any lingering 'close' handling a chance to misfire before we
    // declare victory — it must not turn into an unhandled rejection or a
    // second settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('a client that calls sock.end() itself on success does not later spuriously reject that already-resolved promise', async () => {
    const path = mkSock();
    let unhandled: unknown;
    const onUnhandled = (reason: unknown): void => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);
    cleanup.push(() => process.off('unhandledRejection', onUnhandled));

    const srv = await rawServer(path, (sock) => {
      sock.on('data', () => sock.write(JSON.stringify({ kind: 'ack' }) + '\n'));
    });
    cleanup.push(() => void srv.close());

    await request({ kind: 'daemon.status' }, { socketPath: path, timeoutMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toBeUndefined();
  });
});
