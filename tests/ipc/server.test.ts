// tests/ipc/server.test.ts
//
// Integration-style test: bind a real unix socket + client, round-trip a
// few request kinds. Uses an ephemeral temp dir so parallel tests don't
// collide.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startIpcServer, type IpcServerHandler } from '../../src/ipc/server.js';
import { request, stream } from '../../src/ipc/client.js';
import type { IpcResponse } from '../../src/ipc/protocol.js';

describe('IPC server', () => {
  let dir: string;
  let sockPath: string;
  let server: Awaited<ReturnType<typeof startIpcServer>>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tlive-ipc-srv-'));
    sockPath = join(dir, 'daemon.sock');
  });
  afterEach(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips daemon.status', async () => {
    const handler: IpcServerHandler = async (req, reply) => {
      if (req.kind === 'daemon.status') {
        reply({ kind: 'daemon.status', uptimeMs: 123, sessionCount: 1, warmPoolCount: 0, pid: 99 });
      }
    };
    server = await startIpcServer({ path: sockPath, handler });

    const resp = await request({ kind: 'daemon.status' }, { path: sockPath });
    expect(resp.kind).toBe('daemon.status');
    if (resp.kind === 'daemon.status') {
      expect(resp.pid).toBe(99);
    }
  });

  it('propagates handler errors as error frames', async () => {
    const handler: IpcServerHandler = async () => { throw new Error('boom'); };
    server = await startIpcServer({ path: sockPath, handler });

    const resp = await request({ kind: 'daemon.status' }, { path: sockPath });
    expect(resp.kind).toBe('error');
    if (resp.kind === 'error') expect(resp.message).toContain('boom');
  });

  it('streams multi-frame responses via stream()', async () => {
    const handler: IpcServerHandler = async (req, reply) => {
      if (req.kind === 'session.logs') {
        reply({ kind: 'logs.line', sdkSessionId: 'sid', line: 'a' });
        reply({ kind: 'logs.line', sdkSessionId: 'sid', line: 'b' });
        reply({ kind: 'logs.end', sdkSessionId: 'sid' });
      }
    };
    server = await startIpcServer({ path: sockPath, handler });

    const frames: IpcResponse[] = [];
    for await (const f of stream({ kind: 'session.logs', alias: 'sid' }, { path: sockPath })) {
      frames.push(f);
    }
    expect(frames.map((f) => f.kind)).toEqual(['logs.line', 'logs.line', 'logs.end']);
  });
});
