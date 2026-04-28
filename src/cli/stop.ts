// src/cli/stop.ts — `tlive stop`
//
// Drives a graceful daemon shutdown and BLOCKS until the OS process is
// gone. Previous versions returned as soon as the IPC `daemon.stop`
// request was acknowledged; the daemon then took ~1.5s to actually tear
// down (frontend / sessions / IPC server close). During that gap a
// follow-up `tlive start` would find the socket still bound and refuse
// with "already running", then the daemon finished, removed the socket,
// and nothing was running.
//
// New contract:
//   1. Read daemon.pid. If absent / dead → cleanup stale socket + exit 0.
//   2. Best-effort IPC `daemon.stop` (don't trust its return).
//   3. Wait up to 10s for PID to disappear.
//   4. Escalate: SIGTERM, wait 3s.
//   5. Escalate: SIGKILL, wait 1s.
//   6. Cleanup stale socket + pid file (best-effort) and exit.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { request, getSocketPath } from '../ipc/client.js';
import { isPidAlive, readDaemonPid, unlinkIfExists, waitFor } from './_liveness.js';

const PID_FILE = join(homedir(), '.tlive', 'daemon.pid');

export async function stopCommand(): Promise<void> {
  const sockPath = getSocketPath();
  const pid = await readDaemonPid(PID_FILE);

  if (pid === null || !isPidAlive(pid)) {
    // No live daemon. Sweep stale artifacts so the next `start` is clean.
    if (pid !== null) unlinkIfExists(PID_FILE);
    unlinkIfExists(sockPath);
    process.stdout.write('tlive daemon: not running\n');
    return;
  }

  // Best-effort IPC stop. We don't trust the response — daemon may exit
  // before flushing the reply, or the socket could be unreachable while
  // the process is still mid-shutdown. Either way we fall through to PID
  // polling below.
  let ipcSent = false;
  try {
    const resp = await request({ kind: 'daemon.stop' }, { timeoutMs: 4000 });
    if (resp.kind === 'daemon.stopped' || resp.kind === 'error') {
      ipcSent = true;
    }
  } catch {
    /* ignore — we'll escalate via signals next */
  }

  // Phase 1: wait up to 10s for graceful exit (frontend.stop + sessions.stopAll
  // + IPC close + persistence flush).
  let dead = await waitFor(() => !isPidAlive(pid), 10_000);
  if (dead) {
    finalize(pid, sockPath, ipcSent ? 'graceful' : 'graceful-no-ipc');
    return;
  }

  // Phase 2: SIGTERM nudge.
  process.stderr.write(`tlive daemon: graceful shutdown stalled, sending SIGTERM to pid ${pid}\n`);
  try { process.kill(pid, 'SIGTERM'); } catch { /* may already be dead */ }
  dead = await waitFor(() => !isPidAlive(pid), 3_000);
  if (dead) {
    finalize(pid, sockPath, 'sigterm');
    return;
  }

  // Phase 3: SIGKILL escalation.
  process.stderr.write(`tlive daemon: SIGTERM ignored, sending SIGKILL to pid ${pid}\n`);
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  dead = await waitFor(() => !isPidAlive(pid), 1_000);
  if (dead) {
    finalize(pid, sockPath, 'sigkill');
    return;
  }

  // Couldn't kill. Surface clearly.
  process.stderr.write(`tlive daemon: kill failed — pid ${pid} still alive\n`);
  process.exit(1);
}

function finalize(pid: number, sockPath: string, mode: string): void {
  unlinkIfExists(PID_FILE);
  unlinkIfExists(sockPath);
  process.stdout.write(`tlive daemon: stopped (pid ${pid}, ${mode})\n`);
}

if (process.argv[1]?.endsWith('tlive-stop.mjs')) {
  await stopCommand();
}
