// src/cli/subcommands/setup.ts
//
// Minimal interactive wizard: prompts for IM tokens, writes config, installs Claude hooks.

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { installClaudeHooks, installCodexHooks, commandOnPath } from '../../kernel/integrations/install-hooks.js';

export async function runSetup(argv: string[]): Promise<void> {
  if (argv.includes('--hooks-only')) {
    const p = installClaudeHooks();
    process.stdout.write(`✓ Claude hooks written to ${p}\n`);
    if (commandOnPath('codex')) {
      const cp = installCodexHooks();
      process.stdout.write(
        `✓ Codex hooks written to ${cp}\n` +
        `  ⚠ Codex 需信任一次才生效:运行 \`codex\`(交互),在 hooks review 里 approve tlive 的 hook。\n`,
      );
    }
    process.stdout.write('Restart claude/codex for changes to take effect.\n');
    return;
  }

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
  cfg.allowedSenders ??= [];
  cfg.adapters ??= {};

  const tgToken = await ask('Telegram bot token (blank to skip)', cfg.adapters.telegram?.token);
  const tgChat = tgToken ? await ask('Telegram chat id (destination)', cfg.adapters.telegram?.chatIdAllowList?.[0]) : '';
  if (tgToken) cfg.adapters.telegram = { token: tgToken, ...(tgChat ? { chatIdAllowList: [tgChat] } : {}) };

  const fsAppId = await ask('Feishu appId (blank to skip)', cfg.adapters.feishu?.appId);
  const fsSecret = fsAppId ? await ask('Feishu appSecret', cfg.adapters.feishu?.appSecret) : '';
  if (fsAppId && fsSecret) cfg.adapters.feishu = { appId: fsAppId, appSecret: fsSecret };

  rl.close();
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  const hooksPath = installClaudeHooks();
  let codexNote = '';
  if (commandOnPath('codex')) {
    const cp = installCodexHooks();
    codexNote = `✓ Codex hooks installed at ${cp}\n  ⚠ Codex 需信任一次:运行 \`codex\` 在 hooks review 里 approve tlive 的 hook。\n`;
  }
  process.stdout.write(`\nWritten ${configPath}\n✓ Claude hooks installed at ${hooksPath}\n${codexNote}Next: tlive start\n`);
}
