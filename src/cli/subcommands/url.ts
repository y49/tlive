// src/cli/subcommands/url.ts
//
// Print the web dashboard URL(s) + a QR code. A focused command for the common
// case: a full-screen TUI (claude) hid the `tlive run` banner, and you just
// want the address to open/scan again. Run it in another terminal.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveWebUrls, printWebBanner } from '../web-url.js';

export async function runUrl(_argv: string[]): Promise<void> {
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  const urls = resolveWebUrls(home);
  if (!urls.enabled) { process.stdout.write('tlive web: disabled (set web.enabled in config).\n'); return; }
  if (!urls.token) { process.stdout.write('tlive web: token not created yet — run `tlive start` first.\n'); return; }
  process.stdout.write('tlive web UI:\n');
  await printWebBanner(home);
}
