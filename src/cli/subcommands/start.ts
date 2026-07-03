// src/cli/subcommands/start.ts
import { spawn } from 'node:child_process';
import { existsSync, openSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { defaultSocketPath, request } from '../../kernel/ipc/client.js';
import { printWebBanner } from '../web-url.js';

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

  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Both bundles live side by side in dist/src/ (import.meta.url is symlink-resolved).
  const daemonEntry = join(__dirname, 'tlive-daemon.mjs');
  if (!existsSync(daemonEntry)) {
    process.stderr.write(`tlive: ${daemonEntry} not found. Run: npm run build\n`);
    process.exit(1);
  }
  mkdirSync(home, { recursive: true });
  if (foreground) {
    spawn(process.execPath, [daemonEntry], { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 0));
    return;
  }
  const logFd = openSync(join(home, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [daemonEntry], { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
  child.unref();
  process.stdout.write(`tlive daemon started (pid ${child.pid})\n`);

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
