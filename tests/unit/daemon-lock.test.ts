import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryAcquireDaemonLock, releaseDaemonLock } from '../../src/cli/_liveness.js';

describe('tryAcquireDaemonLock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tlive-lock-test-'));
    lockPath = join(dir, 'daemon.lock');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('first acquire succeeds and writes our pid', () => {
    const r = tryAcquireDaemonLock(lockPath);
    expect(r).toEqual({ ok: true });
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
  });

  it('second acquire by live owner returns conflict', () => {
    expect(tryAcquireDaemonLock(lockPath)).toEqual({ ok: true });
    const r = tryAcquireDaemonLock(lockPath);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.heldByPid).toBe(process.pid);
  });

  it('stale lock (dead pid) is auto-cleaned and re-acquired', () => {
    writeFileSync(lockPath, '999999', 'utf8');
    const r = tryAcquireDaemonLock(lockPath);
    expect(r).toEqual({ ok: true });
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
  });

  it('garbage in lockfile is treated as stale', () => {
    writeFileSync(lockPath, 'not-a-number', 'utf8');
    const r = tryAcquireDaemonLock(lockPath);
    expect(r).toEqual({ ok: true });
  });

  it('releaseDaemonLock removes lockfile', () => {
    tryAcquireDaemonLock(lockPath);
    releaseDaemonLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releaseDaemonLock is idempotent (no throw on missing)', () => {
    expect(() => releaseDaemonLock(lockPath)).not.toThrow();
  });
});
