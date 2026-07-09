import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnDaemonDetached } from '../spawn';

describe('spawnDaemonDetached', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'tlive-spawn-')); dirs.push(d); return d; };

  it('entry 不存在 → null(不抛)', () => {
    const home = tmp();
    expect(spawnDaemonDetached(home, join(home, 'no-such.mjs'))).toBeNull();
  });

  it('真实 entry → 返回 pid,进程 detached 跑起来(以侧效应文件为证)', async () => {
    const home = tmp();
    const entry = join(home, 'fake-daemon.mjs');
    const marker = join(home, 'ran.txt');
    writeFileSync(entry, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'ok');`);
    const pid = spawnDaemonDetached(home, entry);
    expect(pid).toBeTypeOf('number');
    for (let i = 0; i < 40 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(marker, 'utf-8')).toBe('ok');
    expect(existsSync(join(home, 'daemon.log'))).toBe(true);
  });
});
