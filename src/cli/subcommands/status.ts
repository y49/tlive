// src/cli/subcommands/status.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request } from '../../kernel/ipc/client.js';
import { loadConfig } from '../../kernel/config/loader.js';

export async function runStatus(_argv: string[]): Promise<void> {
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  let daemonOk = false;
  try {
    const r = await request({ kind: 'daemon.status' }, { timeoutMs: 2000 });
    if (r.kind === 'daemon.status') {
      daemonOk = true;
      process.stdout.write(`daemon:   running (pid ${r.pid}, uptime ${(r.uptimeMs / 1000).toFixed(0)}s)\n`);
    }
  } catch { /* not running */ }
  if (!daemonOk) process.stdout.write('daemon:   not running (run: tlive start)\n');

  const cfg = loadConfig(home);
  const dests: string[] = [];
  if (cfg.adapters.telegram?.token && cfg.adapters.telegram.chatIdAllowList?.length) dests.push('telegram');
  if (cfg.adapters.feishu?.chatId) dests.push('feishu');
  process.stdout.write(`channels: ${dests.length ? dests.join(', ') : '(none — run: tlive setup)'}\n`);

  const webEnabled = cfg.web?.enabled !== false;
  if (webEnabled) {
    const bind = cfg.web?.bind ?? '127.0.0.1';
    const port = cfg.web?.port ?? 7681;
    let tokenHint = '';
    try {
      const tok = readFileSync(join(home, 'web-token'), 'utf8').trim();
      if (tok) tokenHint = `?token=${tok}`;
    } catch { /* token created on first daemon start */ }
    process.stdout.write(`web:      http://${bind}:${port}/${tokenHint}\n`);
  } else {
    process.stdout.write('web:      disabled\n');
  }

  const configPath = join(home, 'config.json');
  process.stdout.write(`config:   ${configPath}${existsSync(configPath) ? '' : ' (missing)'}\n`);
  process.stdout.write(`log:      ${join(home, 'daemon.log')}\n`);

  if (!daemonOk) process.exit(1);
}
