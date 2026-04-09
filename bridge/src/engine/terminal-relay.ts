// bridge/src/engine/terminal-relay.ts
//
// Relay between terminal `tlive claude` processes and IM adapters.
// Manages IPC server, target resolution, notification dispatch, and reply routing.

import { createServer, type Socket, type Server } from 'node:net';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { Config } from '../config.js';

// ---------------------------------------------------------------------------
// IPC protocol — message types exchanged between terminal and bridge
// ---------------------------------------------------------------------------

export interface IPCNotification {
  text: string;
  buttons?: Array<{ label: string; callbackData: string; style?: string }>;
  sessionId?: string;
  workdir?: string;
}

export interface IPCPermissionAction {
  action: string;
  toolUseId: string;
  sessionId: string;
}

export interface IPCTerminalInput {
  text: string;
}

// ---------------------------------------------------------------------------
// Target resolution — determine where to send notifications per platform
// ---------------------------------------------------------------------------

export interface ResolvedTarget {
  chatId: string;
  receiveIdType?: string;
}

/** Detect feishu receive_id_type from ID prefix convention. */
function feishuReceiveIdType(id: string): string {
  if (id.startsWith('ou_')) return 'open_id';
  if (id.startsWith('oc_')) return 'chat_id';
  return 'user_id';
}

export type GetLastChatId = (channelType: string) => string;

export class TargetResolver {
  private cachedChatIds: Record<string, string> = {};
  private platformResolvers: Record<string, () => ResolvedTarget | null>;

  constructor(
    private getLastChatId: GetLastChatId,
    config: Config,
    tliveHome: string,
  ) {
    // Load persisted chat IDs
    const chatIdsFile = join(tliveHome, 'runtime', 'chat-ids.json');
    try { this.cachedChatIds = JSON.parse(readFileSync(chatIdsFile, 'utf-8')); } catch { /* none */ }

    // Per-platform config-based fallback
    this.platformResolvers = {
      telegram: () => config.telegram.chatId ? { chatId: config.telegram.chatId } : null,
      feishu: () => {
        const id = config.feishu.allowedUsers[0];
        return id ? { chatId: id, receiveIdType: feishuReceiveIdType(id) } : null;
      },
      discord: () => null,
    };
  }

  resolve(channelType: string): ResolvedTarget | null {
    // 1. Active session (recent IM interaction)
    const active = this.getLastChatId(channelType);
    if (active) return this.withIdType(channelType, active);

    // 2. Platform config
    const fromConfig = this.platformResolvers[channelType]?.();
    if (fromConfig) return fromConfig;

    // 3. Persisted cache
    const cached = this.cachedChatIds[channelType];
    if (cached) return this.withIdType(channelType, cached);

    return null;
  }

  private withIdType(channelType: string, chatId: string): ResolvedTarget {
    return {
      chatId,
      receiveIdType: channelType === 'feishu' ? feishuReceiveIdType(chatId) : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Line-delimited JSON protocol over Unix socket
// ---------------------------------------------------------------------------

function attachLineParser(socket: Socket, onMessage: (msg: Record<string, unknown>) => void): void {
  let buffer = '';
  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); } catch { /* skip */ }
    }
  });
}

function sendJson(socket: Socket, msg: Record<string, unknown>): void {
  socket.write(JSON.stringify(msg) + '\n');
}

// ---------------------------------------------------------------------------
// TerminalRelay — the main class
// ---------------------------------------------------------------------------

export interface TerminalRelayDeps {
  config: Config;
  tliveHome: string;
  getAdapters: () => BaseChannelAdapter[];
  getLastChatId: GetLastChatId;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export class TerminalRelay {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private ipcPath: string;
  private targetResolver: TargetResolver;
  private terminalMsgIds = new Set<string>();
  private deps: TerminalRelayDeps;

  // IPC message handler registry
  private readonly handlers: Record<string, (payload: Record<string, unknown>, socket: Socket) => void>;

  constructor(deps: TerminalRelayDeps) {
    this.deps = deps;
    this.ipcPath = join(deps.tliveHome, 'ipc.sock');
    this.targetResolver = new TargetResolver(deps.getLastChatId, deps.config, deps.tliveHome);

    this.handlers = {
      notification: (p, s) => this.handleNotification(p as unknown as IPCNotification, s),
      session_status: (p) => deps.log(`Terminal session: ${JSON.stringify(p)}`),
      session_list: (_p, s) => {
        // Terminal clients own file-system access via sessionDiscovery;
        // bridge responds with empty list — the real listing happens terminal-side.
        sendJson(s, { type: 'session_list_response', payload: { sessions: [] } });
      },
      config_update: (p) => this.broadcastConfigUpdate(p),
    };
  }

  // ---- Lifecycle ----

  start(): void {
    if (existsSync(this.ipcPath)) unlinkSync(this.ipcPath);

    this.server = createServer((socket) => {
      this.clients.add(socket);
      this.deps.log(`Terminal connected (${this.clients.size} active)`);

      attachLineParser(socket, (msg) => {
        const handler = this.handlers[msg.type as string];
        if (handler) handler(msg.payload as Record<string, unknown>, socket);
      });

      socket.on('close', () => {
        this.clients.delete(socket);
        this.deps.log(`Terminal disconnected (${this.clients.size} active)`);
      });
      socket.on('error', () => this.clients.delete(socket));
    });

    this.server.listen(this.ipcPath, () => this.deps.log(`IPC listening at ${this.ipcPath}`));
  }

  stop(): void {
    for (const client of this.clients) client.destroy();
    this.server?.close();
    try { unlinkSync(this.ipcPath); } catch { /* gone */ }
  }

  // ---- Notification dispatch ----

  private handleNotification(notification: IPCNotification, origin: Socket): void {
    const { text, buttons, sessionId } = notification;

    for (const adapter of this.deps.getAdapters()) {
      const target = this.targetResolver.resolve(adapter.channelType);
      if (!target) continue;

      adapter.send({
        chatId: target.chatId,
        receiveIdType: target.receiveIdType,
        text,
        buttons: buttons?.map((b) => ({
          label: b.label,
          callbackData: b.callbackData,
          style: b.style as 'primary' | 'danger' | undefined,
        })),
      }).then((msgId) => {
        if (msgId) {
          this.terminalMsgIds.add(msgId);
          sendJson(origin, {
            type: 'message_sent',
            payload: { messageId: msgId, sessionId, channelType: adapter.channelType },
          });
        }
      }).catch((err) => {
        this.deps.warn(`→ ${adapter.channelType}: ${err}`);
      });
    }
  }

  // ---- Inbound message interception ----

  /**
   * Check if an inbound IM message is a reply to a terminal notification.
   * Returns true if consumed (forwarded to terminal via IPC).
   */
  interceptReply(msg: { text: string; replyToMessageId?: string }): boolean {
    if (!msg.replyToMessageId || !this.terminalMsgIds.has(msg.replyToMessageId)) {
      return false;
    }
    this.broadcast({ type: 'terminal_input', payload: { text: msg.text } });
    return true;
  }

  /**
   * Handle a callback from IM that targets a terminal session question.
   * Returns true if consumed.
   */
  handleAskCallback(callbackData: string): boolean {
    if (!callbackData.startsWith('askq:')) return false;
    const parts = callbackData.split(':');
    const toolUseId = parts[1];
    const selection = parts[2]; // index number or 'skip'

    const answer = selection === 'skip' ? '' : selection;
    const optionIndex = selection === 'skip' ? -1 : parseInt(selection, 10);

    this.broadcast({
      type: 'question_answer',
      payload: { toolUseId, answer, optionIndex },
    });
    return true;
  }

  /**
   * Forward a config update (effort/model change from IM) to terminal processes.
   */
  forwardConfigUpdate(payload: Record<string, unknown>): void {
    this.broadcast({ type: 'config_update', payload });
  }

  private broadcastConfigUpdate(payload: Record<string, unknown>): void {
    this.broadcast({ type: 'config_update', payload });
  }

  /**
   * Forward a permission action (from IM button press) to terminal processes.
   */
  forwardPermissionAction(action: string, toolUseId: string, sessionId: string): void {
    this.broadcast({
      type: 'permission_action',
      payload: { action, toolUseId, sessionId },
    });
  }

  // ---- Public accessors for session discovery ----

  /** Whether any terminal client (tlive claude) is connected via IPC */
  hasActiveClient(): boolean {
    return this.clients.size > 0;
  }

  /** Resolve notification target for a given channel type */
  resolveTarget(channelType: string): ResolvedTarget | null {
    return this.targetResolver.resolve(channelType);
  }

  // ---- Helpers ----

  private broadcast(msg: Record<string, unknown>): void {
    for (const client of this.clients) sendJson(client, msg);
  }
}
