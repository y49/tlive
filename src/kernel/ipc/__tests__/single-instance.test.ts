import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startIpcServer, AlreadyRunningError, waitUntilSocketFree, type IpcServer } from '../server';
import { request } from '../client';

describe('startIpcServer single-instance', () => {
  const dirs: string[] = [];
  const servers: IpcServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const sockIn = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'tlive-si-'));
    dirs.push(d);
    return join(d, 'ipc.sock');
  };

  it('stale socket 文件被清理后正常 listen', async () => {
    const p = sockIn();
    writeFileSync(p, ''); // 假 stale 文件
    const s = await startIpcServer({ path: p, handler: (_r, reply) => reply({ kind: 'daemon.status', pid: 1, uptimeMs: 0 } as any) });
    servers.push(s);
    const r = await request({ kind: 'daemon.status' } as any, { socketPath: p, timeoutMs: 1000 });
    expect(r.kind).toBe('daemon.status');
  });

  it('活 server 在时第二次 listen 抛 AlreadyRunningError,且不打断第一个', async () => {
    const p = sockIn();
    const a = await startIpcServer({ path: p, handler: (_r, reply) => reply({ kind: 'daemon.status', pid: 42, uptimeMs: 0 } as any) });
    servers.push(a);
    await expect(startIpcServer({ path: p, handler: () => undefined })).rejects.toBeInstanceOf(AlreadyRunningError);
    const r = await request({ kind: 'daemon.status' } as any, { socketPath: p, timeoutMs: 1000 });
    expect((r as any).pid).toBe(42); // A 仍然活着,socket 未被 B 抢掉
  });
});

describe('waitUntilSocketFree (stop;start takeover)', () => {
  const dirs: string[] = [];
  const servers: IpcServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const sockIn = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'tlive-wf-'));
    dirs.push(d);
    return join(d, 'ipc.sock');
  };

  it('resolves true once a dying server releases the socket — the new daemon can take over', async () => {
    const p = sockIn();
    const s = await startIpcServer({ path: p, handler: (_r, reply) => reply({ kind: 'daemon.status', pid: 1, uptimeMs: 0 } as any) });
    setTimeout(() => { void s.close(); }, 500);
    const freed = await waitUntilSocketFree(p, 4000, 100);
    expect(freed).toBe(true);
    // and a new server can actually bind now (the whole point)
    const s2 = await startIpcServer({ path: p, handler: (_r, reply) => reply({ kind: 'daemon.status', pid: 2, uptimeMs: 0 } as any) });
    servers.push(s2);
  });

  it('returns false when the existing server is genuinely alive (steady-state already-running)', async () => {
    const p = sockIn();
    const s = await startIpcServer({ path: p, handler: (_r, reply) => reply({ kind: 'daemon.status', pid: 1, uptimeMs: 0 } as any) });
    servers.push(s);
    const freed = await waitUntilSocketFree(p, 800, 100);
    expect(freed).toBe(false);
  });

  it('a socket that was never occupied is free immediately', async () => {
    const p = sockIn();
    expect(await waitUntilSocketFree(p, 500, 100)).toBe(true);
  });
});
