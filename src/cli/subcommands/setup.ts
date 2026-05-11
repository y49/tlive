// src/cli/subcommands/setup.ts
//
// Minimal interactive wizard: prompts for IM tokens + 1st workspace, writes config.

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function runSetup(_argv: string[]): Promise<void> {
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  mkdirSync(home, { recursive: true });
  const configPath = join(home, 'config.json');
  const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};

  const rl = createInterface({ input, output });
  process.stdout.write('tlive setup — interactive wizard\n');
  process.stdout.write('(press Enter to keep existing values; Ctrl-C to abort)\n\n');

  const ask = async (q: string, current?: string): Promise<string> => {
    const display = current ? `${q} [${current.slice(0, 8)}...]: ` : `${q}: `;
    const ans = (await rl.question(display)).trim();
    return ans || current || '';
  };

  const cfg = { ...existing };
  cfg.workspaces ??= {};
  cfg.chatBindings ??= {};
  cfg.allowedSenders ??= [];
  cfg.adapters ??= {};

  const tgToken = await ask('Telegram bot token (blank to skip)', cfg.adapters.telegram?.token);
  if (tgToken) cfg.adapters.telegram = { ...(cfg.adapters.telegram ?? {}), token: tgToken };

  const fsAppId = await ask('Feishu appId (blank to skip)', cfg.adapters.feishu?.appId);
  const fsSecret = fsAppId ? await ask('Feishu appSecret', cfg.adapters.feishu?.appSecret) : '';
  if (fsAppId && fsSecret) cfg.adapters.feishu = { appId: fsAppId, appSecret: fsSecret };

  const firstWs = await ask('Add workspace (path, blank to skip)');
  if (firstWs) {
    const id = `ws-${firstWs.split('/').filter(Boolean).pop() ?? 'default'}`;
    cfg.workspaces[id] = firstWs;
    process.stdout.write(`(workspace ${id} added)\n`);
  }

  rl.close();
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  process.stdout.write(`\nWritten ${configPath}\nNext: tlive install-integrations && tlive start\n`);
}
