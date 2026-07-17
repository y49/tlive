import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { startIpcServer, type IpcServer } from '../server';
import { request } from '../client';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

const mkSock = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'tlive-ipc-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'x.sock');
};

describe('IpcCallContext.onDisconnect', () => {
  it('fires when the caller disconnects while the handler is still pending', async () => {
    const path = mkSock();
    let fired = false;
    const srv: IpcServer = await startIpcServer({
      path,
      handler: (_req, _reply, ctx) => {
        ctx.onDisconnect?.(() => { fired = true; });
        return new Promise<void>(() => {}); // never resolves — simulates a pending approval
      },
    });
    cleanup.push(() => void srv.close());

    // Send one request, then disconnect immediately (simulates the shim process dying).
    await new Promise<void>((resolve) => {
      const sock = createConnection(path, () => {
        sock.write(JSON.stringify({ kind: 'daemon.status' }) + '\n');
        setTimeout(() => { sock.destroy(); resolve(); }, 30);
      });
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(true);
  });

  it('does NOT fire before the caller disconnects', async () => {
    const path = mkSock();
    let fired = false;
    const srv: IpcServer = await startIpcServer({
      path,
      handler: (_req, reply, ctx) => {
        ctx.onDisconnect?.(() => { fired = true; });
        reply({ kind: 'ack' });
      },
    });
    cleanup.push(() => void srv.close());
    await request({ kind: 'daemon.status' }, { socketPath: path, timeoutMs: 1000 }).catch(() => undefined);
    expect(fired).toBe(false);
  });
});
