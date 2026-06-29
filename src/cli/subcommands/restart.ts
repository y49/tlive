// src/cli/subcommands/restart.ts
//
// Atomic stop+start. In v2.0 the daemon does not own sessions,
// so there is no session-interrupt guard — just restart.

import { request } from '../../kernel/ipc/client.js';

export async function runRestart(argv: string[]): Promise<void> {
  const force = argv.includes('--force') || argv.includes('-f');
  void force; // --force accepted but no longer guards sessions

  try {
    await request({ kind: 'daemon.status' });
  } catch {
    // daemon not running — restart means start fresh
  }

  // Delegate to stop + start
  const { runStop } = await import('./stop.js');
  await runStop([]);
  const { runStart } = await import('./start.js');
  await runStart([]);
}
