// src/kernel/daemon/main.ts

import { join } from 'node:path';
import { homedir } from 'node:os';
import { bootstrapDaemon } from './bootstrap.js';
import { TelegramAdapter } from '../../adapters/im/telegram.js';
import { FeishuAdapter } from '../../adapters/im/feishu.js';
import { loadConfig } from '../config/loader.js';
import { AlreadyRunningError, waitUntilSocketFree } from '../ipc/server.js';
import { daemonSocketPath } from '../ipc/client.js';

export async function runDaemonMain(): Promise<void> {
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  const cfg = loadConfig(home);
  const ims = [
    cfg.adapters.telegram?.token ? new TelegramAdapter({ token: cfg.adapters.telegram.token, allowedChatIds: cfg.adapters.telegram.chatIdAllowList }) : null,
    cfg.adapters.feishu ? new FeishuAdapter(cfg.adapters.feishu) : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);

  let handle;
  try {
    handle = await bootstrapDaemon({ home, imAdapters: ims });
  } catch (e) {
    if (!(e instanceof AlreadyRunningError)) throw e;
    // stop;start 连敲:旧 daemon 要 ~2s 才退完,start 曾在这里让位走人 →
    // 旧的随后退掉,没人活着,用户以为重启成功(真机两次踩坑)。改成:
    // 等旧 socket 释放再接管;等满窗口还活着 = 真·已在运行,照旧干净退出。
    const sockPath = daemonSocketPath(home);
    if (!(await waitUntilSocketFree(sockPath))) throw e;
    handle = await bootstrapDaemon({ home, imAdapters: ims });
  }

  process.on('SIGTERM', () => { void handle.shutdown(); });
  process.on('SIGINT', () => { void handle.shutdown(); });

  // Keep alive — IPC server already does, but defense.
  setInterval(() => { /* heartbeat */ }, 60_000).unref();
}

if (process.argv[1]?.endsWith('tlive-daemon.mjs')) {
  runDaemonMain().catch((e) => {
    if (e instanceof AlreadyRunningError) {
      process.stderr.write('tlive daemon: already running, exiting.\n');
      process.exit(0); // 懒启动竞态的输家:干净退出,不是错误
    }
    process.stderr.write(`tlive daemon: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
