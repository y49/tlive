import { loadConfig } from './config.js';
import { initBridgeContext, type PermissionGateway, type CoreClient } from './context.js';
import { Logger } from './logger.js';
import { JsonFileStore } from './store/json-file.js';
import { resolveProvider } from './providers/index.js';
import { PendingPermissions } from './permissions/gateway.js';
import { BridgeManager } from './engine/bridge-manager.js';
import { TerminalRelay } from './engine/terminal-relay.js';
import { createAdapter } from './channels/index.js';
import type { ChannelType } from './channels/types.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';

function writeStatusFile(tliveHome: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(join(tliveHome, 'runtime'), { recursive: true });
    writeFileSync(join(tliveHome, 'runtime', 'status.json'), JSON.stringify(data, null, 2));
  } catch { /* non-fatal */ }
}

async function main() {
  const config = loadConfig();
  const tliveHome = join(homedir(), '.tlive');

  const logger = new Logger(
    join(tliveHome, 'logs', 'bridge.log'),
    [config.token, config.telegram.botToken, config.discord.botToken, config.feishu.appSecret].filter(Boolean),
  );

  logger.info('TLive Bridge starting...');
  logger.info(`Enabled channels: ${config.enabledChannels.join(', ') || 'none'}`);

  writeStatusFile(tliveHome, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    channels: config.enabledChannels,
    version: '1.0.0',
  });

  // Core components
  const store = new JsonFileStore(join(tliveHome, 'data'));
  const permissions = new PendingPermissions();
  const llm = resolveProvider(config.runtime, permissions, {
    claudeSettingSources: config.claudeSettingSources,
  });

  initBridgeContext({
    store, llm,
    permissions: permissions as PermissionGateway,
    core: {} as CoreClient,
    defaultWorkdir: config.defaultWorkdir,
  });

  // IM adapters
  const manager = new BridgeManager();
  for (const channelType of config.enabledChannels) {
    try {
      manager.registerAdapter(createAdapter(channelType as ChannelType));
      logger.info(`Registered ${channelType} adapter`);
    } catch (err) {
      logger.warn(`Failed to create ${channelType} adapter: ${err}`);
    }
  }
  await manager.start();
  logger.info('Bridge started — SDK-only mode');

  // Terminal relay — IPC bridge between `tlive claude` and IM adapters
  const relay = new TerminalRelay({
    config,
    tliveHome,
    getAdapters: () => manager.getAdapters(),
    getLastChatId: (ch) => manager.getLastChatId(ch),
    log: (msg) => logger.info(msg),
    warn: (msg) => logger.warn(msg),
  });

  relay.start();

  // Wire IM → terminal: reply interception + permission/question callbacks
  manager.onInboundMessage = (_ch, msg) => relay.interceptReply(msg);
  manager.onTerminalPermissionCallback = (action, id, sid) => relay.forwardPermissionAction(action, id, sid);
  manager.onTerminalQuestionCallback = (data) => relay.handleAskCallback(data);
  manager.onConfigUpdate = (update) => relay.forwardConfigUpdate(update);

  // Graceful shutdown
  const keepAliveInterval = setInterval(() => {}, 60_000);
  const shutdown = async (reason = 'signal') => {
    logger.info('Shutting down...');
    clearInterval(keepAliveInterval);
    relay.stop();
    writeStatusFile(tliveHome, {
      pid: process.pid,
      exitedAt: new Date().toISOString(),
      exitReason: reason,
    });
    await manager.stop();
    permissions.denyAll();
    logger.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
