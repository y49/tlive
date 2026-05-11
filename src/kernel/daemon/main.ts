// src/kernel/daemon/main.ts

import { join } from 'node:path';
import { homedir } from 'node:os';
import { bootstrapDaemon } from './bootstrap.js';
import { TelegramAdapter } from '../../adapters/im/telegram.js';
import { FeishuAdapter } from '../../adapters/im/feishu.js';
import { ClaudeRuntimeAdapter } from '../../adapters/runtime/claude.js';
import { CodexRuntimeAdapter } from '../../adapters/runtime/codex.js';
import { loadConfig } from '../config/loader.js';

export async function runDaemonMain(): Promise<void> {
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  const cfg = loadConfig(home);
  const ims = [
    cfg.adapters.telegram?.token ? new TelegramAdapter({ token: cfg.adapters.telegram.token, allowedChatIds: cfg.adapters.telegram.chatIdAllowList }) : null,
    cfg.adapters.feishu ? new FeishuAdapter(cfg.adapters.feishu) : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);

  const handle = await bootstrapDaemon({
    home,
    imAdapters: ims,
    runtimeFactory: (provider) => {
      if (provider === 'claude') return new ClaudeRuntimeAdapter({ permissionPromptToolName: 'mcp__tlive__approve' });
      if (provider === 'codex') return new CodexRuntimeAdapter();
      throw new Error(`unknown provider: ${provider}`);
    },
  });

  process.on('SIGTERM', () => { void handle.shutdown(); });
  process.on('SIGINT', () => { void handle.shutdown(); });

  // Keep alive — IPC server already does, but defense.
  setInterval(() => { /* heartbeat */ }, 60_000).unref();
}

if (process.argv[1]?.endsWith('tlive-daemon.mjs')) {
  runDaemonMain().catch((e) => {
    process.stderr.write(`tlive daemon: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
