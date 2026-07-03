// src/cli/subcommands/stop.ts
import { request } from '../../kernel/ipc/client.js';

export async function runStop(_argv: string[]): Promise<void> {
  try {
    await request({ kind: 'daemon.stop' }, { timeoutMs: 4000 });
    process.stdout.write('tlive daemon: stopped\n');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // No socket / nobody listening → the daemon is already down. Stopping a
    // stopped daemon is success (idempotent), so `stop && start` chains work.
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      process.stdout.write('tlive daemon: not running\n');
      return;
    }
    process.stderr.write(`tlive stop: ${err.message}\n`);
    process.exit(1);
  }
}
