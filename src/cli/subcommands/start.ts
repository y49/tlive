// src/cli/subcommands/start.ts
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { defaultSocketPath, request } from '../../kernel/ipc/client.js';
import { printWebBanner } from '../web-url.js';
import { spawnDaemonDetached, daemonEntryPath } from '../../kernel/daemon/spawn.js';

export async function runStart(argv: string[]): Promise<void> {
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  const sockPath = defaultSocketPath();
  const foreground = argv.includes('--foreground') || argv.includes('-F');

  // already running?
  try {
    const r = await request({ kind: 'daemon.status' }, { socketPath: sockPath, timeoutMs: 1000 });
    if (r.kind === 'daemon.status') {
      process.stdout.write(`tlive daemon already running (pid ${r.pid})\n\ntlive web UI:\n`);
      await printWebBanner(home);
      return;
    }
  } catch {
    // not running, continue
  }

  const daemonEntry = daemonEntryPath();
  if (foreground) {
    spawn(process.execPath, [daemonEntry], { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 0));
    return;
  }
  const pid = spawnDaemonDetached(home);
  if (pid === null) {
    process.stderr.write('tlive: daemon bundle not found. Run: npm run build\n');
    process.exit(1);
  }
  process.stdout.write(`tlive daemon started (pid ${pid})\n`);

  // Wait for the daemon to come up (token file is created on first start), then show the web entry.
  for (let i = 0; i < 25; i++) {
    try {
      await request({ kind: 'daemon.status' }, { socketPath: sockPath, timeoutMs: 500 });
      process.stdout.write('\ntlive web UI:\n');
      await printWebBanner(home);
      return;
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
}
