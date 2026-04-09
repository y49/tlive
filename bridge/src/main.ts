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
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
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

  // ---------------------------------------------------------------------------
  // ChatId resolver — fallback chain for finding the right IM chat target.
  // Priority: active session chatId → config → persisted chat-ids.json
  // ---------------------------------------------------------------------------

  const chatIdsFile = join(tliveHome, 'runtime', 'chat-ids.json');
  let cachedChatIds: Record<string, string> = {};
  try { cachedChatIds = JSON.parse(readFileSync(chatIdsFile, 'utf-8')); } catch { /* none yet */ }

  const configChatIds: Record<string, string> = {
    telegram: config.telegram.chatId,
  };

  function resolveChatId(channelType: string): string {
    return manager.getLastChatId(channelType)
      || configChatIds[channelType]
      || cachedChatIds[channelType]
      || '';
  }

  // ---------------------------------------------------------------------------
  // IPC Server — message handler registry
  // ---------------------------------------------------------------------------

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
          const handler = ipcHandlers[msg.type];
          if (handler) handler(msg.payload, socket);
          else logger.warn(`IPC unknown message type: ${msg.type}`);
        } catch { /* skip malformed */ }
      }
    });
    socket.on('close', () => {
      ipcClients.delete(socket);
      logger.info(`IPC client disconnected (total: ${ipcClients.size})`);
    });
    socket.on('error', () => ipcClients.delete(socket));
  });

  // Track terminal notification messageIds — replies to these should be forwarded via IPC
  const terminalNotificationMsgIds = new Set<string>();

  /** Typed IPC message handlers. */
  const ipcHandlers: Record<string, (payload: Record<string, unknown>, socket: Socket) => void> = {
    notification(payload, socket) {
      const { text, buttons, sessionId } = payload as {
        text: string;
        buttons?: Array<{ label: string; callbackData: string; style?: string }>;
        sessionId?: string;
      };

      for (const adapter of manager.getAdapters()) {
        const chatId = resolveChatId(adapter.channelType);
        if (!chatId) continue;

        adapter.send({
          chatId,
          text,
          buttons: buttons?.map((b) => ({
            label: b.label,
            callbackData: b.callbackData,
            style: b.style as 'primary' | 'danger' | undefined,
          })),
        }).then((sentMsgId) => {
          if (sentMsgId) {
            terminalNotificationMsgIds.add(sentMsgId);
            socket.write(JSON.stringify({
              type: 'message_sent',
              payload: { messageId: sentMsgId, sessionId, channelType: adapter.channelType },
            }) + '\n');
          }
        }).catch((err) => {
          logger.warn(`IPC → ${adapter.channelType} failed: ${err}`);
        });
      }
    },

    session_status(payload) {
      logger.info(`IPC session status: ${JSON.stringify(payload)}`);
    },
  };

  // Intercept inbound IM messages — if replying to a terminal notification,
  // forward the text via IPC instead of routing to SDK engine.
  manager.onInboundMessage = (channelType: string, msg: { text: string; replyToMessageId?: string }) => {
    if (msg.replyToMessageId && terminalNotificationMsgIds.has(msg.replyToMessageId)) {
      // Forward reply text to terminal session via IPC
      const ipcMsg = JSON.stringify({
        type: 'terminal_input',
        payload: { text: msg.text },
      }) + '\n';
      for (const client of ipcClients) client.write(ipcMsg);
      return true; // consumed — don't route to SDK
    }
    return false; // not a terminal reply — proceed normally
  };

  // Forward IM permission callbacks → IPC → tlive claude process
  manager.onTerminalPermissionCallback = (action, toolUseId, sessionId) => {
    const msg = JSON.stringify({
      type: 'permission_action',
      payload: { action, toolUseId, sessionId },
    }) + '\n';
    for (const client of ipcClients) client.write(msg);
  };

  if (existsSync(IPC_PATH)) unlinkSync(IPC_PATH);
  ipcServer.listen(IPC_PATH, () => logger.info(`IPC server listening at ${IPC_PATH}`));

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
