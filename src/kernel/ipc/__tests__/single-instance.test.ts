import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startIpcServer, AlreadyRunningError, type IpcServer } from '../server';
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
