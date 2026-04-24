// src/daemon/lifecycle.ts
//
// Daemon lifecycle — SIGTERM/SIGINT handling + orderly subsystem teardown
// (spec §13.1). Reentrancy-guarded so a double-SIGTERM doesn't interleave
// shutdown steps.
//
// Ordering (spec §13.1):
//   1. stop cron loop
//   2. close platform adapters
//   3. stopAll sessions
//   4. drain warm pool
//   5. close IPC server
//   6. stop health server
//   7. close federation downstream procs
//   8. flush logs (best-effort: nothing buffered yet)

import type { Logger } from '../util/logger.js';

export interface ShutdownStep {
  name: string;
  run(): Promise<void> | void;
}

export interface LifecycleHandle {
  /** Kick off shutdown. Resolves once every step has completed (or errored). */
  shutdown(): Promise<void>;
  /** Is shutdown currently in progress or complete? */
  isShuttingDown(): boolean;
}

export interface InstallSignalsOptions {
  handle: LifecycleHandle;
  /** Custom exit fn — tests pass a spy. Default: process.exit. */
  exit?: (code: number) => void;
  /** Signals to handle. Default: ['SIGTERM','SIGINT']. */
  signals?: NodeJS.Signals[];
  /** Custom signal.subscribe fn — tests bypass process. */
  bind?: (signal: NodeJS.Signals, fn: () => void) => void;
  logger?: Logger;
}

export function createLifecycle(steps: ShutdownStep[], logger?: Logger): LifecycleHandle {
  let shuttingDown = false;
  let completion: Promise<void> | null = null;

  async function shutdown(): Promise<void> {
    if (completion) return completion;
    shuttingDown = true;
    completion = (async () => {
      for (const step of steps) {
        const t0 = Date.now();
        try {
          await step.run();
          logger?.info('shutdown step ok', { step: step.name, durMs: Date.now() - t0 });
        } catch (err) {
          logger?.error('shutdown step failed', { step: step.name, reason: (err as Error).message });
        }
      }
    })();
    return completion;
  }

  return {
    shutdown,
    isShuttingDown: () => shuttingDown,
  };
}

export function installSignalHandlers(opts: InstallSignalsOptions): () => void {
  const signals = opts.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[]);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const handlers: Array<{ sig: NodeJS.Signals; fn: () => void }> = [];

  for (const sig of signals) {
    const fn = () => {
      if (opts.handle.isShuttingDown()) {
        opts.logger?.warn('signal while shutdown in progress; ignoring', { signal: sig });
        return;
      }
      opts.logger?.info('signal received; shutting down', { signal: sig });
      opts.handle.shutdown()
        .then(() => exit(0))
        .catch((err) => { opts.logger?.error('shutdown promise rejected', { reason: (err as Error).message }); exit(1); });
    };
    handlers.push({ sig, fn });
    if (opts.bind) opts.bind(sig, fn);
    else process.on(sig, fn);
  }

  return () => {
    for (const h of handlers) {
      if (!opts.bind) process.off(h.sig, h.fn);
    }
  };
}
