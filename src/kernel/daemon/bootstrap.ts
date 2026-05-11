// src/kernel/daemon/bootstrap.ts

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { startIpcServer, type IpcServer } from '../ipc/server.js';
import { WorkspaceRegistry } from '../workspace/registry.js';
import { ChatRouter } from '../workspace/chat-router.js';
import { SessionManager } from '../session/manager.js';
import { PermissionBroker } from '../permission/broker.js';
import { PermissionRouter } from './permission-router.js';
import { AskBroker } from '../permission/ask-broker.js';
import { NotifyBroker } from '../permission/notify-broker.js';
import { loadConfig } from '../config/loader.js';
import type { RuntimeAdapter } from '../contracts/runtime-adapter.js';
import type { IMAdapter } from '../contracts/im-adapter.js';

export interface DaemonHandle {
  shutdown(): Promise<void>;
  workspaces: WorkspaceRegistry;
  router: ChatRouter;
  sessions: SessionManager;
  permissions: PermissionBroker;
  permissionRouter: PermissionRouter;
  askBroker: AskBroker;
  notifyBroker: NotifyBroker;
  ipcSocketPath: string;
}

export interface BootstrapOpts {
  home: string;
  imAdapters?: IMAdapter[];
  runtimeFactory?: (provider: string) => RuntimeAdapter;
}

export async function bootstrapDaemon(opts: BootstrapOpts): Promise<DaemonHandle> {
  mkdirSync(opts.home, { recursive: true });
  const cfg = loadConfig(opts.home);
  const startedAt = Date.now();

  const workspaces = new WorkspaceRegistry({ home: opts.home });
  const router = new ChatRouter({ bindings: cfg.chatBindings, allowedSenders: cfg.allowedSenders });
  const permissions = new PermissionBroker();
  const sessions = new SessionManager({
    home: opts.home,
    runtimeFactory: opts.runtimeFactory ?? ((_p) => { throw new Error('no runtime factory'); }),
  });

  // Build per-workspace chat lookup from config (channel:chatId → workspaceId reversed)
  const chatsForWorkspace = (wsId: string): Array<{ channel: string; chatId: string }> => {
    const out: Array<{ channel: string; chatId: string }> = [];
    for (const [chatKey, ws] of Object.entries(cfg.chatBindings)) {
      if (ws !== wsId) continue;
      const [channel, chatId] = chatKey.split(':', 2);
      if (channel && chatId) out.push({ channel, chatId });
    }
    return out;
  };
  const sendToChat = async (
    target: { channel: string; chatId: string },
    msg: { title?: string; body?: string; text?: string; level?: string; requestId?: string },
  ): Promise<void> => {
    const adapter = (opts.imAdapters ?? []).find((a) => a.channel === target.channel);
    if (!adapter) return;
    if (msg.text !== undefined) {
      await adapter.send({ kind: 'text', text: msg.text });
    } else {
      await adapter.send({
        kind: 'card',
        ...(msg.title ? { title: msg.title } : {}),
        body: msg.body ?? '',
        ...(msg.requestId ? { buttons: [{ id: `approve:${msg.requestId}`, label: '✅ 允许' }, { id: `deny:${msg.requestId}`, label: '❌ 拒绝' }] } : {}),
      });
    }
  };

  const permissionRouter = new PermissionRouter({
    workspaces,
    chatsForWorkspace,
    sendToChat: async (t, card) => sendToChat(t, { title: card.title, body: card.body, requestId: card.requestId }),
  });
  const askBroker = new AskBroker();
  askBroker.onRequest((req) => {
    // Push question card to all bound chats for the pid's workspace.
    // For now, we don't track pid→workspace for askBroker; this is a TODO when InboundHandler ties pid to chat.
    // Simplification: broadcast to all bound chats configured.
    const allTargets = Object.entries(cfg.chatBindings).map(([k]) => {
      const [c, id] = k.split(':', 2);
      return { channel: c ?? '', chatId: id ?? '' };
    });
    for (const t of allTargets) void sendToChat(t, { text: `❓ ${req.question} (reply with: /ask-answer ${req.requestId} <text>)` });
  });
  const notifyBroker = new NotifyBroker({
    workspaceForPid: (_pid) => undefined, // wired by Phase 6.4 / InboundHandler
    chatsForWorkspace,
    sendToChat: async (t, m) => sendToChat(t, { text: `[${m.level}] ${m.text}` }),
  });

  const sockPath = join(opts.home, 'daemon.sock');
  const ipc: IpcServer = await startIpcServer({
    path: sockPath,
    handler: async (req, reply, ctx) => {
      // Always log caller (fixes "no observability into who killed daemon" bug).
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'ipc.request', kind: req.kind, callerPid: ctx.callerPid ?? null }));

      switch (req.kind) {
        case 'daemon.status':
          reply({ kind: 'daemon.status', uptimeMs: Date.now() - startedAt, pid: process.pid, sessionCount: sessions.listActive().length });
          return;
        case 'daemon.stop':
          reply({ kind: 'daemon.stopped' });
          setTimeout(() => { void shutdown(); }, 10).unref?.();
          return;
        case 'session.list':
          reply({
            kind: 'session.list',
            sessions: sessions.listActive().map((s) => ({
              tliveSessionId: s.tliveSessionId, providerSessionId: s.providerSessionId,
              provider: s.provider, workspaceDir: s.workspaceDir,
            })),
          });
          return;
        case 'mcp.attach': {
          const wsId = permissionRouter.attach({ cwd: req.cwd, pid: req.pid });
          reply({ kind: 'mcp.attached', workspaceId: wsId });
          return;
        }
        case 'mcp.permission.request': {
          const r = await permissionRouter.requestPermission({
            pid: ctx.callerPid ?? -1,
            toolName: req.toolName,
            input: req.input,
          });
          reply({ kind: 'mcp.permission.result', approved: r.approved });
          return;
        }
        case 'mcp.permission.answer':
          permissionRouter.answer(req.requestId, req.approved);
          reply({ kind: 'daemon.stopped' }); // ACK reuse
          return;
        case 'mcp.ask': {
          const reply_text = await askBroker.ask({
            pid: ctx.callerPid ?? -1,
            question: req.question,
            timeoutSec: req.timeoutSec ?? 300,
          });
          reply({ kind: 'mcp.ask.result', reply: reply_text });
          return;
        }
        case 'mcp.notify':
          await notifyBroker.push({
            pid: ctx.callerPid ?? -1,
            message: req.message,
            level: req.level ?? 'info',
          });
          reply({ kind: 'mcp.notify.ack' });
          return;
        default:
          reply({ kind: 'error', message: `unhandled request: ${(req as { kind: string }).kind}` });
      }
    },
  });

  // Start adapters (inbound wiring is Phase 6.4)
  for (const a of opts.imAdapters ?? []) {
    await a.start();
  }

  let stopped = false;
  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;
    for (const a of opts.imAdapters ?? []) await a.stop();
    await sessions.stopAll();
    await ipc.close();
    // ZOMBIE FIX: belt-and-suspenders force-exit if event loop won't drain.
    setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('tlive daemon: forced exit (event loop did not drain in 2s)');
      process.exit(0);
    }, 2000).unref();
  }

  return {
    shutdown, workspaces, router, sessions, permissions, permissionRouter, askBroker, notifyBroker,
    ipcSocketPath: sockPath,
  };
}
