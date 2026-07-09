// src/cli/subcommands/setup.ts
//
// Minimal interactive wizard: prompts for IM tokens, writes config, installs Claude hooks.

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { installClaudePlugin, installCodexPlugin, defaultRunner } from '../../kernel/integrations/plugin-install.js';
import { stripLegacyClaudeHooks, stripLegacyCodexHooks } from '../../kernel/integrations/hooks-cleanup.js';

function registerPlugins(): string {
  const run = defaultRunner();
  const lines: string[] = [];
  const cc = installClaudePlugin(run);
  if (cc.ok) {
    const stripped = stripLegacyClaudeHooks();
    lines.push(`✓ Claude plugin registered — ${cc.detail}${stripped ? '(已清理旧直写 hooks)' : ''}`);
  } else {
    lines.push(`⚠ Claude plugin not registered: ${cc.detail}`);
  }
  const cx = installCodexPlugin(run);
  if (cx.ok) {
    const stripped = stripLegacyCodexHooks();
    lines.push(
      `✓ Codex plugin registered — ${cx.detail}${stripped ? '(已清理旧直写 hooks)' : ''}\n` +
      '  ⚠ Codex 需信任一次才生效:运行 `codex`(交互),在 hooks review 里 approve tlive 的 hook。',
    );
  } else if (cx.detail !== 'codex not on PATH') {
    lines.push(`⚠ Codex plugin not registered: ${cx.detail}`);
  }
  return lines.join('\n') + '\n';
}

export async function runSetup(argv: string[]): Promise<void> {
  if (argv.includes('--hooks-only')) {
    process.stdout.write(registerPlugins() + 'Restart claude/codex for changes to take effect.\n');
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
  const pluginLines = registerPlugins();
  process.stdout.write(`\nWritten ${configPath}\n${pluginLines}Next: tlive start\n`);
}
