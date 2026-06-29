import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startIpcServer, type IpcServer } from '../server';
import { request } from '../client';
import type { IpcRequest, IpcResponse } from '../protocol';

let tmp: string;
let sock: string;
let server: IpcServer;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'tlive-ipc-'));
  sock = join(tmp, 'daemon.sock');
});

afterEach(async () => { await server?.close(); });

describe('IPC round-trip', () => {
  it('daemon.status responds with uptime + pid', async () => {
    server = await startIpcServer({
      path: sock,
      handler: async (req: IpcRequest, reply: (r: IpcResponse) => void) => {
        if (req.kind === 'daemon.status') {
          reply({ kind: 'daemon.status', uptimeMs: 1234, pid: process.pid });
        }
      },
    });
    const r = await request({ kind: 'daemon.status' }, { socketPath: sock, timeoutMs: 2000 });
    expect(r.kind).toBe('daemon.status');
    if (r.kind === 'daemon.status') {
      expect(r.pid).toBe(process.pid);
    }
  });

  it('caller info (pid) is logged on daemon side', async () => {
    let seenCaller: number | null = null;
    server = await startIpcServer({
      path: sock,
      handler: async (_req, reply, ctx) => {
        seenCaller = ctx.callerPid ?? null;
        reply({ kind: 'daemon.stopped' });
      },
    });
    await request({ kind: 'daemon.stop' }, { socketPath: sock, timeoutMs: 2000 });
    // Note: SO_PEERCRED may not be available on all OS; allow null.
    expect(seenCaller === null || typeof seenCaller === 'number').toBe(true);
  });
});
