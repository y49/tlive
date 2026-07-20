// src/cli/subcommands/stop.ts
import { request, defaultSocketPath } from '../../kernel/ipc/client.js';
import { waitUntilSocketFree } from '../../kernel/ipc/server.js';

export async function runStop(_argv: string[]): Promise<void> {
  try {
    await request({ kind: 'daemon.stop' }, { timeoutMs: 4000 });
    // Don't return while the daemon is still dying (~2s to drain / forced
    // exit). Returning early made `tlive stop; tlive start` a trap: start
    // probed the still-live socket, yielded, and the old daemon then exited —
    // leaving NOTHING running while the user believed they had restarted
    // (bitten twice on real hardware). Waiting here makes stop;start correct.
    const freed = await waitUntilSocketFree(defaultSocketPath(), 8000, 200);
    if (!freed) {
      process.stdout.write('tlive daemon: stop requested, but it is still shutting down — wait a moment before `tlive start`\n');
      process.exit(1);
    }
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
