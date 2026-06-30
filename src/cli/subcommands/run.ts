// src/cli/subcommands/run.ts
import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync } from 'node:fs';
import { SessionHost } from '../../kernel/pty/session-host.js';
import { defaultSocketPath, request } from '../../kernel/ipc/client.js';
import type { SessionMeta } from '../../kernel/ipc/protocol.js';

export function gitBranch(cwd: string): string | null {
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return m && m[1] ? m[1] : null;
  } catch {
    return null;
  }
}

export function deriveLabel(cmd: string, cwd: string): string {
  const base = basename(cwd) || cwd;
  const branch = gitBranch(cwd);
  return branch ? `${cmd} @ ${base} (${branch})` : `${cmd} @ ${base}`;
}

export async function runRun(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    process.stderr.write('Usage: tlive run <cmd> [args...]\n');
    process.exit(1);
  }
  const [cmd, ...args] = argv;
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  const sessDir = join(home, 'sessions');
  mkdirSync(sessDir, { recursive: true });

  const id = randomUUID();
  const sockPath = join(sessDir, `${id}.sock`);
  const cwd = process.cwd();
  const label = deriveLabel(cmd, cwd);
  const sock = defaultSocketPath();

  const host = new SessionHost({ id, cmd, args, cwd, sockPath, attachLocal: true });
  await host.start();

  const meta: SessionMeta = { id, label, cmd, cwd, pid: process.pid, sockPath };
  // best-effort register; degrades silently if the daemon is down (local terminal still works).
  await request({ kind: 'session.register', session: meta }, { socketPath: sock, timeoutMs: 1500 }).catch(() => undefined);

  const finish = (code: number): void => {
    void request({ kind: 'session.unregister', id }, { socketPath: sock, timeoutMs: 1500 })
      .catch(() => undefined)
      .finally(() => process.exit(code));
  };
  host.onExit(finish);

  const onSignal = (): void => { void host.stop().finally(() => finish(130)); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
