// src/cli/subcommands/doctor.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request } from '../../kernel/ipc/client.js';
import { loadConfig } from '../../kernel/config/loader.js';

export async function runDoctor(_argv: string[]): Promise<void> {
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // daemon running?
  try {
    const r = await request({ kind: 'daemon.status' }, { timeoutMs: 1000 });
    checks.push({ name: 'daemon', ok: r.kind === 'daemon.status', detail: r.kind === 'daemon.status' ? `pid ${r.pid}` : 'no response' });
  } catch {
    checks.push({ name: 'daemon', ok: false, detail: 'not running (run: tlive start)' });
  }

  // config exists?
  const configPath = join(home, 'config.json');
  checks.push({ name: 'config', ok: existsSync(configPath), detail: configPath });

  // adapter creds present?
  const cfg = loadConfig(home);
  checks.push({ name: 'telegram', ok: !!cfg.adapters.telegram?.token, detail: cfg.adapters.telegram?.token ? 'token configured' : 'no token (skip)' });
  checks.push({ name: 'feishu', ok: !!(cfg.adapters.feishu?.appId && cfg.adapters.feishu?.appSecret), detail: cfg.adapters.feishu ? 'creds configured' : 'no creds (skip)' });

  // claude jsonl access?
  const claudeProj = join(homedir(), '.claude', 'projects');
  checks.push({ name: 'claude jsonl', ok: existsSync(claudeProj), detail: claudeProj });

  // codex sessions access?
  const codexSess = join(homedir(), '.codex', 'sessions');
  checks.push({ name: 'codex sessions', ok: existsSync(codexSess), detail: codexSess });

  // Print
  let okCount = 0;
  for (const c of checks) {
    const icon = c.ok ? '[OK  ]' : '[WARN]';
    process.stdout.write(`${icon} ${c.name.padEnd(15)} ${c.detail}\n`);
    if (c.ok) okCount++;
  }
  process.stdout.write(`\n${okCount}/${checks.length} ok\n`);
  if (okCount < checks.length) process.exit(1);
}
