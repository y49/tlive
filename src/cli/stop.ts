// src/cli/stop.ts — `tlive stop`
//
// Requests an orderly daemon shutdown via IPC. Falls back to SIGTERM on the
// PID file when the socket is unreachable. Never force-kills; operators can
// use `kill -9` if needed.

import { request, getSocketPath } from '../ipc/client.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function stopCommand(): Promise<void> {
  const sock = getSocketPath();
  if (existsSync(sock)) {
    try {
      const resp = await request({ kind: 'daemon.stop' }, { timeoutMs: 4000 });
      if (resp.kind === 'daemon.stopped') {
        process.stdout.write('tlive daemon: shutdown requested\n');
        return;
      }
      if (resp.kind === 'error') {
        process.stderr.write(`error: ${resp.message}\n`);
      }
    } catch (err) {
      process.stderr.write(`ipc stop failed (${(err as Error).message}); trying SIGTERM\n`);
    }
  }

  const pidFile = join(homedir(), '.tlive', 'daemon.pid');
  if (!existsSync(pidFile)) {
    process.stdout.write('tlive daemon: not running\n');
    return;
  }
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  if (!Number.isFinite(pid)) {
    process.stderr.write('daemon.pid is corrupt; removing\n');
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    process.stdout.write(`tlive daemon: SIGTERM sent to pid ${pid}\n`);
  } catch (err) {
    process.stderr.write(`kill failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('tlive-stop.mjs')) {
  await stopCommand();
}
