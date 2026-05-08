// src/daemon/main.ts
//
// Entry point for the tlive daemon process. Invoked via
// `dist/src/tlive-daemon.mjs` (build target) or via the `tlive start` CLI
// wrapper. Responsibilities:
//   - acquire exclusive daemon.lock before any other init
//   - bootstrap subsystems (`bootstrapDaemon`)
//   - install SIGTERM / SIGINT handlers via `installSignalHandlers`
//   - keep the event loop pinned open; only exit via lifecycle shutdown
//
// Unhandled errors during bootstrap are logged to stderr and the process
// exits with code 1 so scripts/cli.js can surface the failure.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { bootstrapDaemon, type DaemonHandle } from './bootstrap.js';
import { installSignalHandlers } from './lifecycle.js';
import { createLogger } from '../util/logger.js';
import { tryAcquireDaemonLock, releaseDaemonLock } from '../cli/_liveness.js';

export async function main(): Promise<DaemonHandle> {
  // ---- Lock: must be the very first thing — before any await, IPC bind, or
  // adapter init. Exit 73 when another daemon already holds the lock.
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  mkdirSync(home, { recursive: true });
  const lockPath = join(home, 'daemon.lock');

  const lockResult = tryAcquireDaemonLock(lockPath);
  if (!lockResult.ok) {
    process.stderr.write(
      `tlive-daemon: another daemon already running (pid ${lockResult.heldByPid}); exiting\n`,
    );
    process.exit(73);
  }

  const releaseLock = () => releaseDaemonLock(lockPath);
  // Lock release fires on the 'exit' event regardless of exit path:
  //   - normal shutdown: lifecycle.shutdown() → process.exit(0) → 'exit'
  //   - uncaughtException handler → process.exit(1) → 'exit'
  //   - lock-conflict early-return: process.exit(73) (no lock to release)
  // SIGINT/SIGTERM are handled exclusively by installSignalHandlers below
  // so adapter shutdown stays graceful on operator stop.
  process.on('exit', releaseLock);
  process.on('uncaughtException', (err) => {
    releaseLock();
    process.stderr.write(`tlive-daemon: uncaught: ${(err as Error).stack}\n`);
    process.exit(1);
  });

  const logger = createLogger();
  const daemon = await bootstrapDaemon({ home, logger });
  installSignalHandlers({ handle: daemon.lifecycle, logger });

  // Keep-alive: the IPC server + adapters + timers hold the event loop open,
  // but if all optional subsystems are disabled in tests, nothing does. An
  // unref'd interval guarantees a non-empty queue without blocking shutdown.
  const keepAlive = setInterval(() => { /* heartbeat */ }, 60_000);
  keepAlive.unref?.();

  return daemon;
}

// Auto-run only when this module is the *direct* entry point. A basename
// check prevents false positives when main.ts is bundled into another entry
// (e.g. src/cli/start.ts → dist/src/tlive-start.mjs); `import.meta.url` of
// the bundled module coincides with process.argv[1] because esbuild inlines
// the URL, so a plain URL-equality guard would fire twice.
if (process.argv[1]?.endsWith('tlive-daemon.mjs')) {
  main().catch((err) => {
    process.stderr.write(`tlive daemon failed: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
