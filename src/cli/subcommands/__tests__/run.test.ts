import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveLabel, gitBranch, ensureDaemonUp } from '../run';
import { startIpcServer, type IpcServer } from '../../../kernel/ipc/server';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tlive-run-')); });

describe('gitBranch', () => {
  it('returns null when not a git repo', () => {
    expect(gitBranch(dir)).toBeNull();
  });
  it('parses branch from .git/HEAD', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
    expect(gitBranch(dir)).toBe('feat/x');
  });
});

describe('ensureDaemonUp (run 懒启动)', () => {
  const dirs: string[] = [];
  const servers: IpcServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'tlive-edu-')); dirs.push(d); return d; };
  const statusHandler = (_r: unknown, reply: (x: unknown) => void): void =>
    reply({ kind: 'daemon.status', pid: 7, uptimeMs: 0 });

  it('daemon 已在 → true,不调 autoStart', async () => {
    const home = tmp();
    const sock = join(home, 'ipc.sock');
    servers.push(await startIpcServer({ path: sock, handler: statusHandler as never }));
    let called = 0;
    expect(await ensureDaemonUp(home, sock, () => { called++; return true; })).toBe(true);
    expect(called).toBe(0);
  });

  it('daemon 不在 + autoStart 返回 false(禁用)→ false,不轮询等待', async () => {
    const home = tmp();
    const t0 = Date.now();
    expect(await ensureDaemonUp(home, join(home, 'ipc.sock'), () => false)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2500); // 只有一次探活,没有 3s 轮询
  });

  it('daemon 不在 + autoStart 拉起(注入:直接起一个 IPC server)→ 轮询后 true', async () => {
    const home = tmp();
    const sock = join(home, 'ipc.sock');
    expect(await ensureDaemonUp(home, sock, () => {
      void startIpcServer({ path: sock, handler: statusHandler as never }).then((s) => servers.push(s));
      return true;
    })).toBe(true);
  });
});

describe('deriveLabel', () => {
  it('is "<cmd> @ <basename>" without git', () => {
    expect(deriveLabel('claude', '/home/u/proj')).toBe('claude @ proj');
  });
  it('appends the git branch when present', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(deriveLabel('codex', dir)).toBe(`codex @ ${join(dir).split('/').filter(Boolean).pop()} (main)`);
  });
});
