// src/cli/subcommands/status.ts
import { request } from '../../kernel/ipc/client.js';

export async function runStatus(_argv: string[]): Promise<void> {
  try {
    const r = await request({ kind: 'daemon.status' }, { timeoutMs: 2000 });
    if (r.kind !== 'daemon.status') throw new Error('unexpected response');
    process.stdout.write(`pid: ${r.pid}\nuptime: ${(r.uptimeMs / 1000).toFixed(0)}s\n`);
  } catch {
    process.stdout.write('tlive daemon: not running\n');
    process.exit(1);
  }
}
