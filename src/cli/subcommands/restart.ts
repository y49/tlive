// src/cli/subcommands/restart.ts
//
// Atomic stop+start that REFUSES if there are active sessions, unless --force.

import { request } from '../../kernel/ipc/client.js';

export async function runRestart(argv: string[]): Promise<void> {
  const force = argv.includes('--force') || argv.includes('-f');

  let sessionCount = 0;
  try {
    const status = await request({ kind: 'daemon.status' });
    if (status.kind === 'daemon.status') {
      sessionCount = status.sessionCount;
    }
  } catch {
    // daemon not running — restart means start fresh
  }

  if (sessionCount > 0 && !force) {
    process.stderr.write(
      `tlive restart: ${sessionCount} active session(s) would be interrupted.\n` +
      `Re-run with --force to proceed, or use 'tlive stop' then check.\n`,
    );
    process.exit(2);
    return; // unreachable in production
  }

  // Delegate to stop + start
  const { runStop } = await import('./stop.js');
  await runStop([]);
  const { runStart } = await import('./start.js');
  await runStart([]);
}
