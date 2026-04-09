// bridge/src/engine/terminal-relay.ts
//
// Relay between terminal `tlive claude` processes and IM adapters.
// Manages IPC server, target resolution, notification dispatch, and reply routing.

import { type Socket } from 'node:net';
import { readFileSync, readFileSync as fsReadFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { Config } from '../config.js';
import { IPCServer } from './ipc-server.js';
import { SessionRegistry } from './session-registry.js';

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
// TerminalRelay — the main class
// ---------------------------------------------------------------------------

export interface TerminalRelayDeps {
  config: Config;
  tliveHome: string;
  webDir?: string;
  getAdapters: () => BaseChannelAdapter[];
  getLastChatId: GetLastChatId;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

export class TerminalRelay {
  private ipcServer: IPCServer;
  private registry = new SessionRegistry();
  private targetResolver: TargetResolver;
  private terminalMsgIds = new Set<string>();
  private deps: TerminalRelayDeps;

  // Web terminal — HTTP + WebSocket server
  private httpServer: HttpServer | null = null;
  private wsServer: WebSocketServer | null = null;
  private webClients = new Map<string, Set<WebSocket>>();

  // IPC message handler registry
  private readonly handlers: Record<string, (payload: Record<string, unknown>, socket: Socket) => void>;

  constructor(deps: TerminalRelayDeps) {
    this.deps = deps;
    const ipcPath = join(deps.tliveHome, 'ipc.sock');
    this.ipcServer = new IPCServer(ipcPath, deps.log);
    this.targetResolver = new TargetResolver(deps.getLastChatId, deps.config, deps.tliveHome);

    this.handlers = {
      notification: (p, s) => this.handleNotification(p as unknown as IPCNotification, s),
      session_status: (p) => deps.log(`Terminal session: ${JSON.stringify(p)}`),
      session_list: (_p, s) => {
        // Terminal clients own file-system access via sessionDiscovery;
        // bridge responds with empty list — the real listing happens terminal-side.
        this.ipcServer.reply(s, { type: 'session_list_response', payload: { sessions: [] } });
      },
      config_update: (p) => this.broadcastConfigUpdate(p),
      session_register: (p, s) => {
        const { sessionId, workdir, projectName } = p as any;
        this.registry.register(sessionId, s, { workdir, projectName: projectName || '' });
        this.deps.log(`Session registered: ${sessionId.slice(0, 8)} (${projectName})`);
      },
      session_unregister: (p) => {
        const { sessionId } = p as any;
        this.registry.unregister(sessionId);
        const clients = this.webClients.get(sessionId);
        if (clients) {
          for (const ws of clients) ws.close();
          this.webClients.delete(sessionId);
        }
        this.deps.log(`Session unregistered: ${(sessionId as string).slice(0, 8)}`);
      },
      pty_data: (p) => {
        const { sessionId, data } = p as { sessionId: string; data: string };
        const clients = this.webClients.get(sessionId);
        if (clients) {
          const buf = Buffer.from(data);
          for (const ws of clients) {
            if (ws.readyState === ws.OPEN) ws.send(buf);
          }
        }
      },
    };
  }

  // ---- Lifecycle ----

  start(): void {
    this.ipcServer.on('message', (payload: Record<string, unknown>, type: string, socket: Socket) => {
      const handler = this.handlers[type];
      if (handler) handler(payload, socket);
    });

    this.ipcServer.on('disconnect', (socket: Socket) => {
      // Remove sessions owned by this socket and close their web clients
      const removedIds = this.registry.removeBySocket(socket);
      for (const sid of removedIds) {
        const wsClients = this.webClients.get(sid);
        if (wsClients) {
          for (const ws of wsClients) ws.close();
          this.webClients.delete(sid);
        }
      }
    });

    this.ipcServer.start();

    // Start web terminal HTTP + WebSocket server
    this.startWebServer();
  }

  stop(): void {
    // Close web clients
    for (const clients of this.webClients.values()) {
      for (const ws of clients) ws.close();
    }
    this.wsServer?.close();
    this.httpServer?.close();
    // Close IPC
    this.ipcServer.stop();
  }

  // ---- Web terminal server ----

  private startWebServer(): void {
    const port = this.deps.config.port || 8849;
    const token = this.deps.config.token;
    const webDir = this.deps.webDir || process.env.TL_WEB_DIR || '';

    this.httpServer = createHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      // Token check for HTML pages
      const needsAuth = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/terminal.html';
      if (needsAuth && token && url.searchParams.get('token') !== token) {
        res.writeHead(403); res.end('Unauthorized'); return;
      }

      // Session list page
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const sessions = this.registry.listSessions();
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(this.renderSessionList(sessions, token));
        return;
      }

      // Serve static files from web/
      if (webDir) {
        const safePath = url.pathname.replace(/\.\./g, '');
        const filePath = join(webDir, safePath);
        if (existsSync(filePath)) {
          try {
            const content = fsReadFileSync(filePath);
            const mime = MIME[extname(filePath)] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime });
            res.end(content);
            return;
          } catch { /* fall through */ }
        }
      }

      res.writeHead(404); res.end('Not found');
    });

    this.wsServer = new WebSocketServer({ server: this.httpServer });
    this.wsServer.on('connection', (ws: WebSocket, req) => {
      const url = new URL(req.url ?? '', `http://localhost:${port}`);
      if (token && url.searchParams.get('token') !== token) {
        ws.close(4001, 'Unauthorized'); return;
      }

      const sessionId = url.searchParams.get('session');
      if (!sessionId || !this.registry.getSession(sessionId)) {
        ws.close(4002, 'Session not found'); return;
      }

      // Register web client
      if (!this.webClients.has(sessionId)) this.webClients.set(sessionId, new Set());
      this.webClients.get(sessionId)!.add(ws);

      // Web input -> IPC -> terminal process
      ws.on('message', (raw) => {
        const data = raw.toString();
        const session = this.registry.getSession(sessionId);
        if (session) {
          this.ipcServer.reply(session.socket, { type: 'web_input', payload: { data } });
        }
      });

      ws.on('close', () => {
        this.webClients.get(sessionId)?.delete(ws);
      });
    });

    this.httpServer.listen(port, () => {
      this.deps.log(`Web terminal at http://localhost:${port}`);
    });
  }

  private renderSessionList(
    sessions: Array<{ sessionId: string; projectName: string; workdir: string }>,
    token: string,
  ): string {
    const tokenParam = token ? `?token=${token}` : '';
    const tokenAmp = token ? `&token=${token}` : '';
    if (sessions.length === 0) {
      return `<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:3em">
        <h2>TLive Web Terminal</h2><p>No active sessions</p>
        <p>Start one with: <code>tlive claude</code></p></body></html>`;
    }
    const items = sessions.map(s =>
      `<li><a href="/terminal.html${tokenParam ? tokenParam + '&' : '?'}session=${s.sessionId}">${s.projectName || 'session'} &middot; #${s.sessionId.slice(0, 6)}</a> <small>${s.workdir}</small></li>`
    ).join('');
    return `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2em">
      <h2>TLive Web Terminal</h2><ul style="list-style:none;padding:0">${items}</ul></body></html>`;
  }

  // ---- Notification dispatch ----

  private handleNotification(notification: IPCNotification, origin: Socket): void {
    const { text, buttons, sessionId } = notification;

    for (const adapter of this.deps.getAdapters()) {
      const target = this.targetResolver.resolve(adapter.channelType);
      if (!target) continue;

      // Determine card header style based on notification content
      const isPermission = text.includes('Permission');
      const isQuestion = text.includes('Question');
      const isDone = text.includes('Done');
      const isThinking = text.includes('Thinking');
      const feishuHeader = adapter.channelType === 'feishu' ? {
        template: isPermission ? 'orange' : isQuestion ? 'blue' : isDone ? 'green' : isThinking ? 'grey' : 'turquoise',
        title: isPermission ? 'Permission Request' : isQuestion ? 'Question' : isDone ? 'Done' : isThinking ? 'Thinking...' : 'Terminal',
      } : undefined;

      adapter.send({
        chatId: target.chatId,
        receiveIdType: target.receiveIdType,
        text,
        buttons: buttons?.map((b) => ({
          label: b.label,
          callbackData: b.callbackData,
          style: b.style as 'primary' | 'danger' | undefined,
        })),
        feishuHeader,
      } as any).then((result: any) => {
        const msgId = result?.messageId;
        if (msgId) {
          this.terminalMsgIds.add(msgId);
          this.deps.log(`Tracked notification: ${msgId}`);
          this.ipcServer.reply(origin, {
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
    this.deps.log(`interceptReply: replyTo=${msg.replyToMessageId ?? 'NONE'}, tracked=${this.terminalMsgIds.size}, match=${msg.replyToMessageId ? this.terminalMsgIds.has(msg.replyToMessageId) : false}`);
    if (!msg.replyToMessageId || !this.terminalMsgIds.has(msg.replyToMessageId)) {
      return false;
    }
    this.deps.log(`Forwarding reply to terminal: "${msg.text.slice(0, 50)}"`);
    this.ipcServer.broadcast({ type: 'terminal_input', payload: { text: msg.text } });
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

    this.ipcServer.broadcast({
      type: 'question_answer',
      payload: { toolUseId, answer, optionIndex },
    });
    return true;
  }

  /**
   * Forward a config update (effort/model change from IM) to terminal processes.
   */
  forwardConfigUpdate(payload: Record<string, unknown>): void {
    this.ipcServer.broadcast({ type: 'config_update', payload });
  }

  private broadcastConfigUpdate(payload: Record<string, unknown>): void {
    this.ipcServer.broadcast({ type: 'config_update', payload });
  }

  /**
   * Forward a permission action (from IM button press) to terminal processes.
   */
  forwardPermissionAction(action: string, toolUseId: string, sessionId: string): void {
    this.ipcServer.broadcast({
      type: 'permission_action',
      payload: { action, toolUseId, sessionId },
    });
  }

  // ---- Public accessors for session discovery ----

  /** Whether any terminal client (tlive claude) is connected via IPC */
  hasActiveClient(): boolean {
    return this.ipcServer.clientCount > 0;
  }

  /** Resolve notification target for a given channel type */
  resolveTarget(channelType: string): ResolvedTarget | null {
    return this.targetResolver.resolve(channelType);
  }

}
