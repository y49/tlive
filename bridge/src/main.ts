import { loadConfig } from './config.js';
import { initBridgeContext, type PermissionGateway } from './context.js';
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
import { discoverActiveSessions } from './engine/session-discovery.js';
import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker as RuntimePermissionBroker } from '../../src/session/permission-broker.js';
import { ClaudeSdkRuntime } from '../../src/runtime/claude-sdk.js';
import { CodexAppServerRuntime } from '../../src/runtime/codex-app-server/index.js';
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

  // SessionManager wiring (Phase 1 — feature-flagged via TL_USE_SESSION_MANAGER).
  // Built unconditionally so the flag-off path still benefits from validated deps;
  // BridgeManager only subscribes when the flag is set.
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

  const useSessionManager = process.env.TL_USE_SESSION_MANAGER === '1';

  // IM adapters
  const manager = new BridgeManager({
    sessionManager: useSessionManager ? sessionManager : null,
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
  logger.info('Bridge started — SDK-only mode');

  // Typed IPC session handler — accepts CLI requests regardless of the
  // TL_USE_SESSION_MANAGER flag. Legacy scanner-path IPC messages
  // (session_register, etc.) use different `type` values so they don't collide
  // with the `type: 'request'` envelope the handler consumes.
  const ipc = new IPCServer();
  ipc.start(IPC_PATH_V1);
  const ipcSessionHandler = new IPCSessionHandler(ipc, sessionManager, runtimeBroker, manager.getWorkspaceManager());
  ipcSessionHandler.start();

  // Terminal relay — IPC bridge between `tlive claude` and IM adapters
  const relay = new TerminalRelay({
    config,
    tliveHome,
    webDir: process.env.TL_WEB_DIR || '',
    getAdapters: () => manager.getAdapters(),
    getLastChatId: (ch) => manager.getLastChatId(ch),
    renderers: manager.getRenderers(),
    log: (msg) => logger.info(msg),
    warn: (msg) => logger.warn(msg),
  });

  relay.start();

  // Session discovery — detect non-tlive Claude sessions and notify IM
  const knownSessions = new Set<string>();
  const DISCOVERY_INTERVAL = 30_000;
  const bootTime = Date.now();

  // Pre-populate known sessions so we don't spam on first boot
  for (const s of discoverActiveSessions(5 * 60 * 1000)) {
    knownSessions.add(s.sessionId);
  }

  const discoveryTimer = setInterval(() => {
    const sessions = discoverActiveSessions(5 * 60 * 1000); // active in last 5 min

    for (const session of sessions) {
      if (knownSessions.has(session.sessionId)) continue;
      knownSessions.add(session.sessionId);

      // Only notify for sessions that are waiting for user input
      if (!session.isWaiting) continue;

      // Don't notify for sessions managed via IPC (tlive claude) or SDK (bridge-initiated)
      if (relay.hasActiveClient() || manager.hasActiveSessions()) continue;

      // Notify IM
      const renderers = manager.getRenderers();
      for (const adapter of manager.getAdapters()) {
        const target = relay.resolveTarget(adapter.channelType);
        if (!target) continue;

        const renderer = renderers.get(adapter.channelType as ChannelType);
        if (!renderer) continue;
        adapter.send(target.chatId, renderer.renderCommandResponse({
          title: '🖥 Claude session detected',
          body: `${session.projectName} · #${session.sessionId.slice(0, 6)}\n\nClaude is waiting for input`,
          buttons: [
            { label: '💬 Resume from IM', callbackData: `resume:${session.sessionId}:${session.workdir}` },
            { label: '🔕 Ignore', callbackData: `resume:ignore:${session.sessionId}` },
          ],
        })).catch(() => {});
      }
    }
  }, DISCOVERY_INTERVAL);

  // Wire IM → terminal: reply interception + permission/question callbacks
  manager.onInboundMessage = (_ch, msg) => relay.interceptReply(msg);
  manager.isTerminalReply = (replyToMessageId) => relay.isReplyToTracked(replyToMessageId);
  manager.onTerminalPermissionCallback = (action, id, sid) => relay.forwardPermissionAction(action, id, sid);
  manager.onTerminalQuestionCallback = (data) => relay.handleAskCallback(data);
  manager.onConfigUpdate = (update) => relay.forwardConfigUpdate(update);

  // Graceful shutdown
  const keepAliveInterval = setInterval(() => {}, 60_000);
  const shutdown = async (reason = 'signal') => {
    logger.info('Shutting down...');
    clearInterval(keepAliveInterval);
    clearInterval(discoveryTimer);
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
