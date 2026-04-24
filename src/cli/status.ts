// src/cli/status.ts — `tlive status`
//
// Calls the daemon's IPC server for `daemon.status`. When the socket is
// absent we don't auto-spawn here — status should reflect reality.

import { request, getSocketPath } from '../ipc/client.js';
import { existsSync } from 'node:fs';

export async function statusCommand(): Promise<void> {
  const path = getSocketPath();
  if (!existsSync(path)) {
    process.stdout.write('tlive daemon: not running\n');
    return;
  }
  try {
    const resp = await request({ kind: 'daemon.status' });
    if (resp.kind === 'daemon.status') {
      const uptimeS = Math.round(resp.uptimeMs / 1000);
      process.stdout.write(`tlive daemon: running (pid ${resp.pid})\n`);
      process.stdout.write(`  uptime:      ${uptimeS}s\n`);
      process.stdout.write(`  sessions:    ${resp.sessionCount}\n`);
      process.stdout.write(`  warm pool:   ${resp.warmPoolCount}\n`);
    } else if (resp.kind === 'error') {
      process.stderr.write(`error: ${resp.message}\n`);
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`tlive daemon: unreachable (${(err as Error).message})\n`);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('tlive-status.mjs')) {
  await statusCommand();
}
