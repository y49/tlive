// src/cli/_liveness.ts
//
// Cross-platform liveness + cleanup helpers shared by `tlive start`,
// `tlive stop`, and `tlive restart`. Centralizing these so the three
// commands agree on what "running" means and how to clean up zombies.
//
// The authoritative source of truth for "is the daemon alive" is the OS
// process table — i.e. `process.kill(pid, 0)` against the PID written to
// `~/.tlive/daemon.pid` by bootstrap. Socket files and pid files can both
// linger after a crash; PID liveness cannot.

import { existsSync, unlinkSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';

/**
 * True iff a process with `pid` is alive. Uses signal 0 which performs
 * permission checks but does not actually deliver a signal.
 *
 * - ESRCH → no such process → false.
 * - EPERM → process exists but we lack permission to signal it → still
 *   alive, return true. (e.g. another user's daemon — defensive.)
 *
 * Works on Linux, macOS, and Windows: Node's `process.kill` translates
 * signal 0 to a `OpenProcess` probe on Win32.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read a numeric PID from `pidPath`. Returns null if the file is missing,
 * unreadable, or contains junk.
 */
export async function readDaemonPid(pidPath: string): Promise<number | null> {
  if (!existsSync(pidPath)) return null;
  try {
    const txt = await readFile(pidPath, 'utf8');
    const n = Number(txt.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Poll `pred` every `stepMs` until it returns truthy or `timeoutMs` elapses.
 * Resolves true when the predicate succeeds, false on timeout. Predicates
 * may be async.
 */
export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise<void>((r) => setTimeout(r, stepMs));
  }
  return false;
}

/** Best-effort unlink — never throws. */
export function unlinkIfExists(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

/**
 * Probe an IPC socket / named pipe by attempting a TCP-style connect. Used
 * as a secondary "is the daemon listening?" check after PID liveness, so a
 * `tlive start` returning "started" actually has a server it can talk to.
 */
export function canReachSocket(path: string, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path);
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); sock.end(); resolve(true); });
    sock.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

export type LockResult =
  | { ok: true }
  | { ok: false; heldByPid: number };

/**
 * Acquire an exclusive PID lock at `lockPath` using O_CREAT|O_EXCL.
 *
 * - Atomic across processes via the kernel: only one O_EXCL open succeeds.
 * - On EEXIST: read PID, isPidAlive ? return conflict : unlink + retry once
 *   (recovery from crashed-without-cleanup).
 * - Caller must register releaseDaemonLock in process exit/signal hooks.
 */
export function tryAcquireDaemonLock(lockPath: string): LockResult {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, String(process.pid), 'utf8');
      } finally {
        closeSync(fd);
      }
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let pid: number;
      try {
        const txt = readFileSync(lockPath, 'utf8').trim();
        pid = Number(txt);
        if (!Number.isFinite(pid) || pid <= 0) pid = -1;
      } catch {
        pid = -1;
      }
      if (pid > 0 && isPidAlive(pid)) {
        return { ok: false, heldByPid: pid };
      }
      unlinkIfExists(lockPath);
    }
  }
  return { ok: false, heldByPid: -1 };
}

/** Best-effort lock release. Idempotent. */
export function releaseDaemonLock(lockPath: string): void {
  unlinkIfExists(lockPath);
}
