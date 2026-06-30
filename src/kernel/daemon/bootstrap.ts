// src/kernel/daemon/bootstrap.ts
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { startIpcServer, type IpcServer } from '../ipc/server.js';
import { PermissionRouter, type PermChat } from './permission-router.js';
import { ContinueBroker } from '../permission/continue-broker.js';
import { SenderGuard } from './sender-guard.js';
import { loadConfig } from '../config/loader.js';
import type { IMAdapter } from '../contracts/im-adapter.js';

export interface DaemonHandle {
  shutdown(): Promise<void>;
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

  let muted = false;

  const configuredChats = (): PermChat[] => {
    const out: PermChat[] = [];
    const tg = cfg.adapters.telegram;
    // chatId here is a routing target (presence gate); the adapter enforces the real inbound filter.
    if (tg?.token && tg.chatIdAllowList?.length) out.push({ channel: 'telegram', chatId: tg.chatIdAllowList[0] });
    const fs = cfg.adapters.feishu;
    if (fs?.chatId) out.push({ channel: 'feishu', chatId: fs.chatId });
    return out;
  };

  const sendToChat = async (
    target: PermChat,
    msg: { title?: string; body?: string; text?: string; requestId?: string },
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
    configuredChats,
    sendToChat: (t, card) => sendToChat(t, { title: card.title, body: card.body, requestId: card.requestId }),
    isMuted: () => muted,
  });

  const continueBroker = new ContinueBroker();
  let latestContinueId: string | null = null;

  continueBroker.onRequest((req) => {
    latestContinueId = req.requestId;
    if (muted) return;
    for (const t of configuredChats()) {
      void sendToChat(t, { text: `⏸ ${req.context}\n回复本条以续跑 (id: ${req.requestId})` });
    }
  });

  const senderGuard = new SenderGuard(cfg.allowedSenders);

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
        case 'hook.notify': {
          if (!muted) {
            await Promise.all(configuredChats().map((t) => sendToChat(t, { text: `[${req.level}] ${req.message}` })));
          }
          reply({ kind: 'ack' });
          return;
        }
        default:
          reply({ kind: 'error', message: `unhandled request: ${(req as { kind: string }).kind}` });
      }
    },
  });

  const inbound = new (await import('./inbound-handler.js')).InboundHandler({
    senderGuard,
    imBy: (ch) => (opts.imAdapters ?? []).find((a) => a.channel === ch),
    permissionRouter,
    continueBroker,
    takeLatestContinueId: () => { const id = latestContinueId; latestContinueId = null; return id; },
    setMuted: (m: boolean) => { muted = m; },
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
    setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('tlive daemon: forced exit (event loop did not drain in 2s)');
      process.exit(0);
    }, 2000).unref();
  }

  return { shutdown, permissionRouter, continueBroker, ipcSocketPath: sockPath };
}
