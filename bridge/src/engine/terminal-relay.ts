// bridge/src/engine/terminal-relay.ts
//
// Thin assembly layer — wires IPCServer, SessionRegistry, WebTerminal,
// ReplyInterceptor, NotificationDispatcher, and TargetResolver together.

import { type Socket } from 'node:net';
import { join } from 'node:path';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { ChannelType } from '../channels/types.js';
import type { Config } from '../config.js';
import type { NotificationRenderer } from '../renderers/types.js';
import { IPCServer } from './ipc-server.js';
import { SessionRegistry } from './session-registry.js';
import { WebTerminal } from './web-terminal.js';
import { ReplyInterceptor } from './reply-interceptor.js';
import { NotificationDispatcher, type NotificationPayload } from './notification-dispatcher.js';
import { TargetResolver } from './target-resolver.js';

// Re-export types for downstream consumers
export type { ResolvedTarget, GetLastChatId } from './target-resolver.js';
export type { NotificationPayload } from './notification-dispatcher.js';

export interface TerminalRelayDeps {
  config: Config;
  tliveHome: string;
  webDir?: string;
  getAdapters: () => BaseChannelAdapter[];
  getLastChatId: (channelType: string) => string;
  renderers?: Map<ChannelType, NotificationRenderer>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export class TerminalRelay {
  private ipcServer: IPCServer;
  private registry: SessionRegistry;
  private webTerminal: WebTerminal;
  private replyInterceptor: ReplyInterceptor;
  private notificationDispatcher: NotificationDispatcher;
  private targetResolver: TargetResolver;
  private deps: TerminalRelayDeps;

  constructor(deps: TerminalRelayDeps) {
    this.deps = deps;
    this.ipcServer = new IPCServer(join(deps.tliveHome, 'ipc.sock'), deps.log);
    this.targetResolver = new TargetResolver(deps.getLastChatId, deps.config, deps.tliveHome);
    this.registry = new SessionRegistry();
    this.webTerminal = new WebTerminal({
      port: deps.config.port || 8849, token: deps.config.token,
      webDir: deps.webDir || process.env.TL_WEB_DIR || '',
      registry: this.registry, log: deps.log,
    });
    this.replyInterceptor = new ReplyInterceptor(deps.log);
    this.replyInterceptor.onForward = (msg) => this.ipcServer.broadcast(msg as Record<string, unknown>);
    this.notificationDispatcher = new NotificationDispatcher(
      deps.getAdapters, this.targetResolver,
      deps.renderers ?? new Map(),
      deps.log, deps.warn,
    );
    this.notificationDispatcher.onSent = ({ messageId }) => this.replyInterceptor.trackMessage(messageId);
  }

  start(): void {
    this.ipcServer.on('message', (p: Record<string, unknown>, t: string, s: Socket) => this.routeIPC(t, p, s));
    this.ipcServer.on('disconnect', (socket: Socket) => {
      for (const sid of this.registry.removeBySocket(socket)) this.webTerminal.closeSessionClients(sid);
    });
    this.webTerminal.onWebInput = (sessionId, data) => {
      const session = this.registry.getSession(sessionId);
      if (session) this.ipcServer.reply(session.socket, { type: 'web_input', payload: { data } });
    };
    this.ipcServer.start();
    this.webTerminal.start();
  }

  stop(): void { this.webTerminal.stop(); this.ipcServer.stop(); }

  // ---- Public API (delegated) ----

  interceptReply(msg: { text: string; replyToMessageId?: string }): boolean {
    return this.replyInterceptor.interceptReply(msg);
  }
  isReplyToTracked(replyToMessageId: string | undefined): boolean {
    return this.replyInterceptor.isReplyToTracked(replyToMessageId);
  }
  handleAskCallback(callbackData: string): boolean {
    return this.replyInterceptor.handleAskCallback(callbackData);
  }
  forwardConfigUpdate(payload: Record<string, unknown>): void {
    this.ipcServer.broadcast({ type: 'config_update', payload });
  }
  forwardPermissionAction(action: string, toolUseId: string, sessionId: string): void {
    this.ipcServer.broadcast({ type: 'permission_action', payload: { action, toolUseId, sessionId } });
  }
  hasActiveClient(): boolean { return this.ipcServer.clientCount > 0; }
  resolveTarget(channelType: string) { return this.targetResolver.resolve(channelType); }

  // ---- IPC message routing ----

  private routeIPC(type: string, payload: Record<string, unknown>, socket: Socket): void {
    switch (type) {
      case 'notification': {
        const n = payload as unknown as NotificationPayload;
        this.notificationDispatcher.dispatch(n).then((results) => {
          for (const [channelType, messageId] of results)
            this.ipcServer.reply(socket, { type: 'message_sent', payload: { messageId, sessionId: n.sessionId, channelType } });
        });
        break;
      }
      case 'session_status':
        this.deps.log(`Terminal session: ${JSON.stringify(payload)}`);
        break;
      case 'session_list':
        this.ipcServer.reply(socket, { type: 'session_list_response', payload: { sessions: [] } });
        break;
      case 'config_update':
        this.ipcServer.broadcast({ type: 'config_update', payload });
        break;
      case 'session_register': {
        const { sessionId, workdir, projectName } = payload as any;
        this.registry.register(sessionId, socket, { workdir, projectName: projectName || '' });
        this.deps.log(`Session registered: ${sessionId.slice(0, 8)} (${projectName})`);
        break;
      }
      case 'session_unregister': {
        const { sessionId } = payload as any;
        this.registry.unregister(sessionId);
        this.webTerminal.closeSessionClients(sessionId);
        this.deps.log(`Session unregistered: ${(sessionId as string).slice(0, 8)}`);
        break;
      }
      case 'pty_data': {
        const { sessionId, data } = payload as { sessionId: string; data: string };
        this.webTerminal.forwardPtyData(sessionId, data);
        break;
      }
    }
  }
}
