import { loadConfig } from './config.js';
import { initBridgeContext, type PermissionGateway } from './context.js';
import { Logger } from './logger.js';
import { JsonFileStore } from './store/json-file.js';
import { resolveProvider } from './providers/index.js';
import { PendingPermissions } from './permissions/gateway.js';
import { BridgeManager } from './engine/bridge-manager.js';
import { createAdapter } from './channels/index.js';
import type { ChannelType } from './channels/types.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker as RuntimePermissionBroker } from '../../src/permission/broker.js';
import { ClaudeSdkRuntime } from '../../src/runtime/claude/runtime.js';
import { CodexAppServerRuntime } from '../../src/runtime/codex/runtime.js';
import type { AgentProvider } from '../../src/runtime/types.js';
import { IPCServer, IPC_PATH_V1 } from '../../src/ipc.js';
import { IPCSessionHandler } from './engine/ipc-session-handler.js';

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
    defaultWorkdir: config.defaultWorkdir,
  });

  // SessionManager + runtime broker — the authoritative session runtime.
  const persistence = new SessionPersistence(join(tliveHome, 'sessions'));
  await persistence.init();
  const runtimeBroker = new RuntimePermissionBroker();
  const sessionManager = new SessionManager({
    persistence,
    broker: runtimeBroker,
    runtimeFactory: (provider: AgentProvider) =>
      provider === 'claude' ? new ClaudeSdkRuntime() : new CodexAppServerRuntime(),
  });
  const persisted = await sessionManager.hydrateFromDisk();
  logger.info(`Found ${persisted.length} persisted session(s) on disk`);

  // IM adapters
  const manager = new BridgeManager({
    sessionManager,
    permissionBroker: runtimeBroker,
  });
  for (const channelType of config.enabledChannels) {
    try {
      manager.registerAdapter(createAdapter(channelType as ChannelType));
      logger.info(`Registered ${channelType} adapter`);
    } catch (err) {
      logger.warn(`Failed to create ${channelType} adapter: ${err}`);
    }
  }
  await manager.start();
  logger.info('Bridge started');

  // Typed IPC session handler — accepts CLI requests from `tlive claude/codex`.
  const ipc = new IPCServer();
  ipc.start(IPC_PATH_V1);
  const ipcSessionHandler = new IPCSessionHandler(ipc, sessionManager, runtimeBroker, manager.getWorkspaceManager());
  ipcSessionHandler.start();

  // Graceful shutdown — stop sessions + deny pending broker requests first so
  // runtimes drain into idle-state snapshots before the process exits.
  const keepAliveInterval = setInterval(() => {}, 60_000);
  let shuttingDown = false;
  const shutdown = async (reason = 'signal') => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...');
    clearInterval(keepAliveInterval);
    writeStatusFile(tliveHome, {
      pid: process.pid,
      exitedAt: new Date().toISOString(),
      exitReason: reason,
    });
    try { await sessionManager.stopAll(); } catch { /* isolate */ }
    runtimeBroker.denyAll();
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
