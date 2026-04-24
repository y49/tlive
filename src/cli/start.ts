// src/cli/start.ts — `tlive start` (spawn daemon if not running)
//
// Thin wrapper around the daemon entry. When invoked directly from the CLI
// this file bootstraps the daemon in-process so the operator can Ctrl-C it;
// scripts/cli.js instead detaches via `dist/src/tlive-daemon.mjs`. Both
// modes end up in `src/daemon/main.ts` — this entry just exposes a
// subcommand shape so `tlive start` has a dedicated build artifact.

import { main as runDaemon } from '../daemon/main.js';

export async function startCommand(): Promise<void> {
  const daemon = await runDaemon();
  process.stdout.write(`tlive daemon started (pid ${process.pid}, socket ${daemon.ipc?.path ?? 'disabled'})\n`);
  // Keep the foreground process alive; SIGTERM/SIGINT handlers drive shutdown.
  await new Promise<void>(() => { /* never resolves */ });
}

if (process.argv[1]?.endsWith('tlive-start.mjs')) {
  startCommand().catch((err) => {
    process.stderr.write(`tlive start failed: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
