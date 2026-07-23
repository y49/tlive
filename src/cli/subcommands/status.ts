// src/cli/subcommands/status.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request } from '../../kernel/ipc/client.js';
import { loadConfig } from '../../kernel/config/loader.js';
import { effectiveMode } from '../../kernel/hook/normalizer.js';
import { resolveWebUrls, printWebBanner } from '../web-url.js';
import { pluginHealth, defaultRunner } from '../../kernel/integrations/plugin-install.js';

export async function runStatus(_argv: string[]): Promise<void> {
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  let daemonOk = false;
  try {
    const r = await request({ kind: 'daemon.status' }, { timeoutMs: 2000 });
    if (r.kind === 'daemon.status') {
      daemonOk = true;
      process.stdout.write(`daemon:   running (pid ${r.pid}, uptime ${(r.uptimeMs / 1000).toFixed(0)}s)\n`);
      if (r.codex === 'running') {
        process.stdout.write('codex:    app-server companion running\n');
      } else if (r.codex === 'degraded') {
        process.stdout.write('codex:    app-server companion degraded (respawn failed — approvals local-only)\n');
      } else {
        process.stdout.write('codex:    app-server companion off (codex not found or win32 — approvals local-only)\n');
      }
    }
  } catch { /* not running */ }
  if (!daemonOk) process.stdout.write('daemon:   not running (run: tlive start)\n');

  // Plugin health — the plugin silently vanishing is a lived failure mode
  // (3 days of zero hook traffic before anyone noticed): make it visible here.
  const run = defaultRunner();
  for (const vendor of ['claude', 'codex'] as const) {
    const line = pluginHealth(vendor, run);
    if (line) process.stdout.write(`plugins:  ${line}\n`);
  }

  const cfg = loadConfig(home);
  // Posture line — the single most useful diagnostic for "why didn't I get a card?".
  // Shows the EFFECTIVE mode (same notify-default the shim enforces via effectiveMode).
  const MODE_DESC: Record<'off' | 'notify' | 'full', string> = {
    full: 'full — remote approval ON (holds tool approvals for IM/desktop/dashboard)',
    notify: 'notify — watch + notify only; remote approval OFF (enable: tlive mode full)',
    off: 'off — tlive disabled (hooks are no-ops)',
  };
  process.stdout.write(`mode:     ${MODE_DESC[effectiveMode(cfg.mode)]}\n`);

  const dests: string[] = [];
  if (cfg.adapters.telegram?.token && cfg.adapters.telegram.chatIdAllowList?.length) dests.push('telegram');
  if (cfg.adapters.feishu?.chatId) dests.push('feishu');
  process.stdout.write(`channels: ${dests.length ? dests.join(', ') : '(none — run: tlive setup)'}\n`);

  const urls = resolveWebUrls(home);
  if (urls.enabled && urls.token) {
    process.stdout.write('web:\n');
    await printWebBanner(home);
  } else if (urls.enabled) {
    process.stdout.write('web:      (token created on first `tlive start`)\n');
  } else {
    process.stdout.write('web:      disabled\n');
  }

  const configPath = join(home, 'config.json');
  process.stdout.write(`config:   ${configPath}${existsSync(configPath) ? '' : ' (missing)'}\n`);
  process.stdout.write(`log:      ${join(home, 'daemon.log')}\n`);

  if (!daemonOk) process.exit(1);
}
