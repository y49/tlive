// src/cli/restart.ts — `tlive restart`
//
// `tlive stop && tlive start` rolled into a single command so the
// detach-spawn path can't race the graceful shutdown. `tlive stop` is
// run synchronously (it blocks on PID disappearance up to 14s of total
// escalation budget) and the start path is dispatched by re-exec'ing
// `scripts/cli.js` in `start` mode — i.e. the same code path users hit
// for plain `tlive start`. We delegate rather than duplicating the
// detach logic so the two stay in lockstep.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopCommand } from './stop.js';

export async function restartCommand(): Promise<void> {
  await stopCommand();

  // Re-enter scripts/cli.js to run the standard `start` path. The
  // dispatcher already knows how to detach and wait for socket-ready.
  // `here` is dist/src when built, src/cli when running directly under tsx.
  // Walk up the parent chain so we never re-implement the detach lifecycle.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', '..', 'scripts', 'cli.js'),
    join(here, '..', '..', 'scripts', 'cli.js'),
    join(here, '..', 'scripts', 'cli.js'),
  ];
  const cli = candidates.find((p) => existsSync(p)) ?? candidates[0]!;

  const r = spawnSync(process.execPath, [cli, 'start'], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

if (process.argv[1]?.endsWith('tlive-restart.mjs')) {
  await restartCommand();
}
