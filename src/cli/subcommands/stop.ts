// src/cli/subcommands/stop.ts
import { request } from '../../kernel/ipc/client.js';

export async function runStop(_argv: string[]): Promise<void> {
  try {
    await request({ kind: 'daemon.stop' }, { timeoutMs: 4000 });
    process.stdout.write('tlive daemon: stopped\n');
  } catch (e) {
    process.stderr.write(`tlive stop: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
