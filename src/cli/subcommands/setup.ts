// src/cli/subcommands/setup.ts
//
// Minimal interactive wizard: prompts for IM tokens, writes config, installs Claude hooks.

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { installClaudePlugin, installCodexPlugin, defaultRunner } from '../../kernel/integrations/plugin-install.js';
import { commandOnPath } from '../../kernel/integrations/hooks-cleanup.js';
import { grantCodexTrust } from '../../kernel/integrations/codex-trust-grant.js';

export type VendorSelection = { claude: boolean; codex: boolean };

export function resolveVendorSelection(detected: VendorSelection, answer: string): VendorSelection {
  const a = answer.trim();
  if (a === '1') return { claude: detected.claude, codex: false };
  if (a === '2') return { claude: false, codex: detected.codex };
  return detected;
}

async function registerPlugins(sel: VendorSelection): Promise<string> {
  const run = defaultRunner();
  const lines: string[] = [];
  if (sel.claude) {
    const cc = installClaudePlugin(run);
    if (cc.ok) {
      lines.push(`✓ Claude plugin registered — ${cc.detail}`);
    } else {
      lines.push(`⚠ Claude plugin not registered: ${cc.detail}`);
    }
  }
  if (sel.codex) {
    const cx = installCodexPlugin(run);
    if (cx.ok) {
      lines.push(`✓ Codex plugin registered — ${cx.detail}`);
      const trust = await grantCodexTrust();
      lines.push(trust.verified
        ? `✓ Codex hooks 已自动信任(hooks/list 自检通过${trust.granted ? `,写入 ${trust.granted} 条` : ''})`
        : `⚠ Codex 自动信任未成(${trust.detail})— 在 codex 里输入 /hooks 并 approve tlive 即可`);
    } else if (cx.detail !== 'codex not on PATH') {
      lines.push(`⚠ Codex plugin not registered: ${cx.detail}`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function runSetup(argv: string[]): Promise<void> {
  if (argv.includes('--hooks-only')) {
    process.stdout.write((await registerPlugins({ claude: true, codex: true })) + 'Restart claude/codex for changes to take effect.\n');
    return;
  }

  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  mkdirSync(home, { recursive: true });
  const configPath = join(home, 'config.json');
  const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};

  const rl = createInterface({ input, output });
  process.stdout.write('tlive setup — interactive wizard\n');
  process.stdout.write('(press Enter to keep existing values; Ctrl-C to abort)\n\n');

  // 管道/脚本喂入时 stdin EOF 会自动关闭 readline,之后的 question 抛
  // ERR_USE_AFTER_CLOSE —— 视作"回车跳过",让非交互跑法也能走完并写出 config。
  const question = async (prompt: string): Promise<string> => {
    try { return (await rl.question(prompt)).trim(); } catch { return ''; }
  };
  const ask = async (q: string, current?: string): Promise<string> => {
    const display = current ? `${q} [${current.slice(0, 8)}...]: ` : `${q}: `;
    const ans = await question(display);
    return ans || current || '';
  };

  const detected: VendorSelection = { claude: commandOnPath('claude'), codex: commandOnPath('codex') };
  let sel: VendorSelection = detected;
  if (detected.claude && detected.codex) {
    const ans = await question('装到哪 [1]Claude [2]Codex [3]都装(默认): ');
    sel = resolveVendorSelection(detected, ans);
  } else if (detected.claude || detected.codex) {
    process.stdout.write(`检测到 ${detected.claude ? 'Claude' : 'Codex'},直接安装插件。\n`);
  }
  const pluginLines = await registerPlugins(sel);
  process.stdout.write(`\n${pluginLines}`);

  process.stdout.write(
    '\nIM 现在配或直接回车全跳过 — 稍后在 Claude/Codex 里说“帮我配置 tlive”(或 /tlive:setup),AI 会引导你完成。\n\n',
  );

  const cfg = { ...existing };
  cfg.allowedSenders ??= [];
  cfg.adapters ??= {};

  const tgToken = await ask('Telegram bot token (blank to skip)', cfg.adapters.telegram?.token);
  const tgChat = tgToken ? await ask('Telegram chat id (destination)', cfg.adapters.telegram?.chatIdAllowList?.[0]) : '';
  if (tgToken) cfg.adapters.telegram = { token: tgToken, ...(tgChat ? { chatIdAllowList: [tgChat] } : {}) };

  const fsAppId = await ask('Feishu appId (blank to skip)', cfg.adapters.feishu?.appId);
  const fsSecret = fsAppId ? await ask('Feishu appSecret', cfg.adapters.feishu?.appSecret) : '';
  if (fsAppId && fsSecret) cfg.adapters.feishu = { appId: fsAppId, appSecret: fsSecret };

  try { rl.close(); } catch { /* already closed by piped-EOF */ }
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  process.stdout.write(`\nWritten ${configPath}\nNext: tlive start\n`);
}
