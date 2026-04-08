import { loadConfig } from './config.js';
import { initBridgeContext, type PermissionGateway, type CoreClient } from './context.js';
import { Logger } from './logger.js';
import { JsonFileStore } from './store/json-file.js';
import { resolveProvider, ClaudeSDKProvider } from './providers/index.js';
import { PendingPermissions } from './permissions/gateway.js';
import { BridgeManager } from './engine/bridge-manager.js';
import { createAdapter } from './channels/index.js';
import type { ChannelType } from './channels/types.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';


function writeStatusFile(tliveHome: string, data: Record<string, unknown>): void {
  try {
    const runtimeDir = join(tliveHome, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'status.json'), JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal — don't block startup
  }
}

async function main() {
  const config = loadConfig();
  const tliveHome = join(homedir(), '.tlive');

  const logger = new Logger(
    join(tliveHome, 'logs', 'bridge.log'),
    [config.token, config.telegram.botToken, config.discord.botToken, config.feishu.appSecret].filter(Boolean)
  );

  logger.info('TLive Bridge starting...');
  logger.info(`Enabled channels: ${config.enabledChannels.join(', ') || 'none'}`);

  // Write startup status
  writeStatusFile(tliveHome, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    channels: config.enabledChannels,
    version: '0.1.0',
  });

  // Initialize components
  const store = new JsonFileStore(join(tliveHome, 'data'));
  const permissions = new PendingPermissions();
  const llm = resolveProvider(config.runtime, permissions, {
    claudeSettingSources: config.claudeSettingSources,
  });

  // Initialize context
  initBridgeContext({
    store,
    llm,
    permissions: permissions as PermissionGateway,
    core: {} as CoreClient,
    defaultWorkdir: config.defaultWorkdir,
  });

  // Start Bridge Manager with enabled IM adapters
  const manager = new BridgeManager();

  for (const channelType of config.enabledChannels) {
    try {
      const adapter = createAdapter(channelType as ChannelType);
      manager.registerAdapter(adapter);
      logger.info(`Registered ${channelType} adapter`);
    } catch (err) {
      logger.warn(`Failed to create ${channelType} adapter: ${err}`);
    }
  }

  await manager.start();
  logger.info('Bridge started — SDK-only mode');

  // -----------------------------------------------------------------------
  // IPC Server — receives notifications from `tlive claude` terminal sessions
  // and forwards them to IM adapters. Button callbacks are sent back via IPC.
  // -----------------------------------------------------------------------
  const IPC_PATH = join(tliveHome, 'ipc.sock');
  const ipcClients = new Set<Socket>();

  function startIPCServer() {
    if (existsSync(IPC_PATH)) unlinkSync(IPC_PATH);

    const ipcServer = createServer((socket) => {
      ipcClients.add(socket);
      logger.info(`IPC client connected (total: ${ipcClients.size})`);

      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            handleIPCMessage(msg, socket);
          } catch { /* skip malformed */ }
        }
      });
      socket.on('close', () => {
        ipcClients.delete(socket);
        logger.info(`IPC client disconnected (total: ${ipcClients.size})`);
      });
      socket.on('error', () => ipcClients.delete(socket));
    });

    ipcServer.listen(IPC_PATH, () => {
      logger.info(`IPC server listening at ${IPC_PATH}`);
    });

    return ipcServer;
  }

  function handleIPCMessage(msg: { type: string; payload: Record<string, unknown> }, socket: Socket) {
    if (msg.type === 'notification') {
      // Forward notification to all IM adapters
      const { text, buttons, sessionId } = msg.payload as {
        text: string;
        buttons?: Array<{ label: string; callbackData: string; style?: string }>;
        sessionId?: string;
      };

      for (const adapter of manager.getAdapters()) {
        const chatId = manager.getLastChatId(adapter.channelType);
        if (!chatId) continue;

        const outButtons = buttons?.map((b) => ({
          label: b.label,
          callbackData: b.callbackData,
          style: b.style as 'primary' | 'danger' | undefined,
        }));

        adapter.send({
          chatId,
          text,
          buttons: outButtons,
        }).then((sentMsgId) => {
          // Tell the claude process the messageId so it can track terminal notifications
          if (sentMsgId) {
            const reply = JSON.stringify({
              type: 'message_sent',
              payload: { messageId: sentMsgId, sessionId, channelType: adapter.channelType },
            }) + '\n';
            socket.write(reply);
          }
        }).catch((err) => {
          logger.warn(`IPC notification send failed: ${err}`);
        });
      }
    } else if (msg.type === 'session_status') {
      logger.info(`IPC session status: ${JSON.stringify(msg.payload)}`);
    }
  }

  // Forward IM button callbacks for terminal permissions back via IPC
  manager.onTerminalPermissionCallback = (action: string, toolUseId: string, sessionId: string) => {
    const ipcMsg = JSON.stringify({
      type: 'permission_action',
      payload: { action, toolUseId, sessionId },
    }) + '\n';
    for (const client of ipcClients) {
      client.write(ipcMsg);
    }
  };

  const ipcServer = startIPCServer();

  // Wire permission timeout → IM notification
  if (llm instanceof ClaudeSDKProvider) {
    llm.onPermissionTimeout = (toolName: string, _toolUseId: string) => {
      const text = `\u23f0 Permission timed out (5m)\nTool: ${toolName}\nAction: Denied by default`;
      for (const adapter of manager.getAdapters()) {
        adapter.send({ chatId: '', text }).catch((err) => {
          logger.warn(`Failed to send timeout notification to ${adapter.channelType}: ${err}`);
        });
      }
    };
  }

  // Graceful shutdown
  const shutdown = async (reason = 'signal') => {
    logger.info('Shutting down...');
    clearInterval(keepAliveInterval);
    // Clean up IPC
    for (const client of ipcClients) client.destroy();
    ipcServer.close();
    if (existsSync(IPC_PATH)) unlinkSync(IPC_PATH);
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

  // Keep process alive
  const keepAliveInterval = setInterval(() => {}, 60_000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
