// src/cli/subcommands/url.ts
//
// Print the web dashboard URL(s) + a QR code. A focused command for the common
// case: a full-screen TUI (claude) hid the `tlive run` banner, and you just
// want the address to open/scan again. Run it in another terminal.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveWebUrls, printWebBanner } from '../web-url.js';
import { request } from '../../kernel/ipc/client.js';

export async function runUrl(_argv: string[]): Promise<void> {
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  const urls = resolveWebUrls(home);
  if (!urls.enabled) { process.stdout.write('tlive web: disabled (set web.enabled in config).\n'); return; }
  // The URL is only reachable while the daemon (which serves the web) is up.
  const up = await request({ kind: 'daemon.status' }, { timeoutMs: 1000 }).then(() => true).catch(() => false);
  if (!up) {
    process.stderr.write('tlive daemon is not running — start it first:\n  tlive start\n');
    process.exit(1);
  }
  process.stdout.write('tlive web UI:\n');
  await printWebBanner(home);
}
