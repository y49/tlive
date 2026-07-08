// src/cli/subcommands/status.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request } from '../../kernel/ipc/client.js';
import { loadConfig } from '../../kernel/config/loader.js';
import { resolveWebUrls, printWebBanner } from '../web-url.js';
import { codexHookState } from '../../kernel/integrations/codex-trust.js';

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

  const codexHooks = join(homedir(), '.codex', 'hooks.json');
  const codexCfg = join(homedir(), '.codex', 'config.toml');
  const codexState = codexHookState({
    hooksJsonExists: existsSync(codexHooks),
    configTomlText: existsSync(codexCfg) ? readFileSync(codexCfg, 'utf-8') : null,
    hooksJsonPath: codexHooks,
  });
  if (codexState === 'installed-untrusted') {
    process.stdout.write('codex:    hooks installed but NOT trusted — run `codex` and approve tlive in the hooks review.\n');
  } else if (codexState === 'installed-trusted') {
    process.stdout.write('codex:    hooks installed and trusted\n');
  }

  const cfg = loadConfig(home);
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
