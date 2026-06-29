// src/kernel/daemon/bootstrap.ts

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { startIpcServer, type IpcServer } from '../ipc/server.js';
import { WorkspaceRegistry } from '../workspace/registry.js';
import { ChatRouter } from '../workspace/chat-router.js';
import { PermissionRouter } from './permission-router.js';
import { ContinueBroker } from '../permission/continue-broker.js';
import { loadConfig } from '../config/loader.js';
import type { IMAdapter } from '../contracts/im-adapter.js';

export interface DaemonHandle {
  shutdown(): Promise<void>;
  workspaces: WorkspaceRegistry;
  router: ChatRouter;
  permissionRouter: PermissionRouter;
  continueBroker: ContinueBroker;
  ipcSocketPath: string;
}

export interface BootstrapOpts {
  home: string;
  imAdapters?: IMAdapter[];
}

export async function bootstrapDaemon(opts: BootstrapOpts): Promise<DaemonHandle> {
  mkdirSync(opts.home, { recursive: true });
  const cfg = loadConfig(opts.home);
  const startedAt = Date.now();

  const workspaces = new WorkspaceRegistry({ home: opts.home });
  const router = new ChatRouter({ bindings: cfg.chatBindings, allowedSenders: cfg.allowedSenders });

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
        ...(msg.requestId ? {
          buttons: [
            { id: `approve:${msg.requestId}`, label: '✅ 允许' },
            { id: `deny:${msg.requestId}`, label: '❌ 拒绝' },
          ],
        } : {}),
      });
    }
  };

  const permissionRouter = new PermissionRouter({
    workspaces,
    chatsForWorkspace,
    sendToChat: async (t, card) => sendToChat(t, { title: card.title, body: card.body, requestId: card.requestId }),
  });

  const continueBroker = new ContinueBroker();
  // workspaceId → latest continueRequestId (for inbound free-text routing)
  const latestContinueId = new Map<string, string>();

  continueBroker.onRequest((req) => {
    const ws = workspaces.lookupByCwd(req.cwd);
    if (!ws) return;
    latestContinueId.set(ws.id, req.requestId);
    const targets = chatsForWorkspace(ws.id);
    for (const t of targets) {
      void sendToChat(t, { text: `⏸ ${req.context}\n回复本条以续跑 (continueId: ${req.requestId})` });
    }
  });

  const sockPath = join(opts.home, 'daemon.sock');
  const ipc: IpcServer = await startIpcServer({
    path: sockPath,
    handler: async (req, reply, ctx) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'ipc.request', kind: req.kind, callerPid: ctx.callerPid ?? null }));

      switch (req.kind) {
        case 'daemon.status':
          reply({ kind: 'daemon.status', uptimeMs: Date.now() - startedAt, pid: process.pid });
          return;
        case 'daemon.stop':
          reply({ kind: 'daemon.stopped' });
          setTimeout(() => { void shutdown(); }, 10).unref?.();
          return;
        case 'hook.permission.request': {
          const r = await permissionRouter.requestPermission({ cwd: req.cwd, toolName: req.toolName, input: req.input });
          reply({ kind: 'hook.permission.result', decision: r.decision });
          return;
        }
        case 'hook.permission.answer':
          permissionRouter.answer(req.requestId, req.approved);
          reply({ kind: 'ack' });
          return;
        case 'hook.continue.request': {
          const reply_text = await continueBroker.request({ cwd: req.cwd, context: req.context, timeoutSec: 170 });
          reply({ kind: 'hook.continue.result', reply: reply_text });
          return;
        }
        case 'hook.continue.answer':
          continueBroker.answer(req.requestId, req.reply);
          reply({ kind: 'ack' });
          return;
        case 'hook.notify': {
          const ws = workspaces.lookupByCwd(req.cwd);
          const targets = ws ? chatsForWorkspace(ws.id) : [];
          await Promise.all(targets.map((t) => sendToChat(t, { text: `[${req.level}] ${req.message}` })));
          reply({ kind: 'ack' });
          return;
        }
        default:
          reply({ kind: 'error', message: `unhandled request: ${(req as { kind: string }).kind}` });
      }
    },
  });

  // Wire inbound handling
  const inbound = new (await import('./inbound-handler.js')).InboundHandler({
    router, workspaces,
    imBy: (ch) => (opts.imAdapters ?? []).find((a) => a.channel === ch),
    permissionRouter,
    continueBroker,
    latestContinueId,
  });
  for (const a of opts.imAdapters ?? []) {
    await a.start();
    a.onInbound((env) => { void inbound.handle(env); });
  }

  let stopped = false;
  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;
    for (const a of opts.imAdapters ?? []) await a.stop();
    await ipc.close();
    // ZOMBIE FIX: force-exit if event loop won't drain in 2s.
    setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('tlive daemon: forced exit (event loop did not drain in 2s)');
      process.exit(0);
    }, 2000).unref();
  }

  return {
    shutdown, workspaces, router, permissionRouter, continueBroker,
    ipcSocketPath: sockPath,
  };
}
