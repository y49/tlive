// src/kernel/daemon/bootstrap.ts
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startIpcServer, type IpcServer } from '../ipc/server.js';
import { PermissionRouter, type PermChat } from './permission-router.js';
import { decide as policyDecide, type PolicyState } from '../permission/policy-engine.js';
import { renderApprovalCard } from '../permission/approval-renderer.js';
import { ContinueBroker } from '../permission/continue-broker.js';
import { SenderGuard } from './sender-guard.js';
import { loadConfig } from '../config/loader.js';
import type { IMAdapter } from '../contracts/im-adapter.js';
import { SessionRegistry } from '../web/session-registry.js';
import { startWebServer, type WebServerHandle } from '../web/server.js';
import { loadOrCreateToken } from '../web/token.js';
import { EventHub } from '../web/event-hub.js';
import { applyMonitorEvent } from '../web/session-events.js';

export interface DaemonHandle {
  shutdown(): Promise<void>;
  permissionRouter: PermissionRouter;
  continueBroker: ContinueBroker;
  sessions: SessionRegistry;
  events: EventHub;
  ipcSocketPath: string;
  webUrl?: string;
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
  const policyState: PolicyState = { trustUntilRevoked: false };

  // IM → web deep link. Only meaningful when the user configured an externally
  // reachable base URL (tailscale / reverse proxy) — a 127.0.0.1 link is useless on a phone.
  let deepLink: string | undefined; // set after the web server starts (token known)

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
      await adapter.send({ kind: 'text', text: deepLink ? `${msg.text}\n🔗 ${deepLink}` : msg.text });
    } else {
      await adapter.send({
        kind: 'card',
        ...(msg.title ? { title: msg.title } : {}),
        body: deepLink ? `${msg.body ?? ''}\n🔗 ${deepLink}` : (msg.body ?? ''),
        ...(msg.requestId ? {
          buttons: [
            { id: `approve:${msg.requestId}`, label: '✅ 允许' },
            { id: `deny:${msg.requestId}`, label: '❌ 拒绝' },
            { id: `pause:${msg.requestId}`, label: '⏸ 暂停审批' },
          ],
        } : {}),
      });
    }
  };

  const sessions = new SessionRegistry();
  const events = new EventHub();

  const permissionRouter = new PermissionRouter({
    configuredChats,
    sendToChat: (t, card) => sendToChat(t, { title: card.title, body: card.body, requestId: card.requestId }),
    isMuted: (cwd) => muted || (sessions.get(cwd)?.muted ?? false),
    policyDecide: (req) => {
      const d = policyDecide({ toolName: req.toolName, permissionMode: req.permissionMode }, policyState);
      if (d.decision === 'allow') console.log(`[policy] auto-allow ${req.toolName} (${d.reason})`); // 审计
      return d;
    },
    renderCard: (req) => renderApprovalCard({ toolName: req.toolName, input: req.input }),
    onPending: ({ cwd, requestId, title, body }) => {
      events.broadcast({ type: 'session-upsert', session: sessions.upsert({ cwd, status: 'waiting-approval', pending: { requestId, title, body } }) });
    },
    onResolved: ({ cwd, decision }) => {
      // Non-approved outcomes (deny/defer) leave the session idle; only allow → active.
      events.broadcast({ type: 'session-upsert', session: sessions.upsert({ cwd, status: decision === 'allow' ? 'active' : 'idle', pending: null }) });
    },
  });

  const continueBroker = new ContinueBroker();
  let latestContinueId: string | null = null;

  continueBroker.onRequest((req) => {
    latestContinueId = req.requestId;
    // Thread the continue requestId into the session so a dashboard client can reply to it.
    events.broadcast({ type: 'session-upsert', session: sessions.upsert({ cwd: req.cwd, status: 'waiting-input', continueId: req.requestId }) });
    if (muted || sessions.get(req.cwd)?.muted) return;
    for (const t of configuredChats()) {
      void sendToChat(t, { text: `⏸ ${req.context}\n回复本条以续跑 (id: ${req.requestId})` });
    }
  });

  // Upstream actions from a dashboard client (/ws/events): approve/reply/mute.
  const onAction = (action: import('../web/event-hub.js').EventAction): void => {
    switch (action.type) {
      case 'approve':
        permissionRouter.answer(action.requestId, action.approved);
        return;
      case 'reply':
        continueBroker.answer(action.requestId, action.text);
        return;
      case 'mute': {
        const v = sessions.setMuted(action.id, action.muted);
        if (v) events.broadcast({ type: 'session-upsert', session: v });
        return;
      }
    }
  };

  let web: WebServerHandle | null = null;
  let webUrl: string | undefined;
  if (cfg.web?.enabled !== false) {
    const bind = cfg.web?.bind ?? '127.0.0.1';
    const port = cfg.web?.port ?? 7681;
    const token = loadOrCreateToken(opts.home);
    const here = dirname(fileURLToPath(import.meta.url)); // dist/src
    const webDir = join(here, '..', 'web'); // dist/web (Plan 5)
    try {
      web = await startWebServer({ bind, port, token, sessions, events, onAction, webDir });
      webUrl = web.url;
      if (cfg.web?.publicUrl) deepLink = `${cfg.web.publicUrl.replace(/\/+$/, '')}/?token=${token}`;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`tlive web server failed to start: ${(e as Error).message}`);
    }
  }

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
          const r = await permissionRouter.requestPermission({ cwd: req.cwd, toolName: req.toolName, input: req.input, permissionMode: req.permissionMode });
          reply({ kind: 'hook.permission.result', decision: r.decision });
          return;
        }
        case 'hook.permission.answer':
          permissionRouter.answer(req.requestId, req.approved);
          reply({ kind: 'ack' });
          return;
        case 'hook.continue.request': {
          events.broadcast({ type: 'session-upsert', session: sessions.upsert({ cwd: req.cwd, status: 'waiting-input', ...(req.lastMessage ? { lastMessage: req.lastMessage } : {}) }) });
          const reply_text = await continueBroker.request({ cwd: req.cwd, context: req.context, timeoutSec: 170 });
          // Resolved (replied or timed out): clear the reply target; back to active if continuing, else idle.
          events.broadcast({ type: 'session-upsert', session: sessions.upsert({ cwd: req.cwd, status: reply_text ? 'active' : 'idle', continueId: null }) });
          reply({ kind: 'hook.continue.result', reply: reply_text });
          return;
        }
        case 'hook.notify': {
          if (!muted) {
            await Promise.all(configuredChats().map((t) => sendToChat(t, { text: `[${req.level}] ${req.message}` })));
          }
          events.broadcast(applyMonitorEvent(sessions, { event: 'attention', cwd: req.cwd, sessionId: req.sessionId, message: req.message }));
          reply({ kind: 'ack' });
          return;
        }
        case 'hook.event': {
          events.broadcast(applyMonitorEvent(sessions, req.event));
          reply({ kind: 'ack' });
          return;
        }
        case 'session.register': {
          events.broadcast({ type: 'session-upsert', session: sessions.register(req.session) });
          reply({ kind: 'ack' });
          return;
        }
        case 'session.unregister': {
          const removed = sessions.unregister(req.id);
          if (removed) events.broadcast({ type: 'session-remove', id: removed.id });
          reply({ kind: 'ack' });
          return;
        }
        case 'session.list':
          reply({ kind: 'session.list', sessions: sessions.list() });
          return;
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
    setTrust: (t: boolean) => { policyState.trustUntilRevoked = t; },
  });
  for (const a of opts.imAdapters ?? []) {
    await a.start();
    a.onInbound((env) => { void inbound.handle(env); });
  }

  let stopped = false;
  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;
    const forceExit = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('tlive daemon: forced exit (event loop did not drain in 2s)');
      process.exit(0);
    }, 2000);
    forceExit.unref();
    try {
      for (const a of opts.imAdapters ?? []) await a.stop();
      if (web) await web.close();
      await ipc.close();
    } finally {
      clearTimeout(forceExit);
    }
  }

  return { shutdown, permissionRouter, continueBroker, sessions, events, webUrl, ipcSocketPath: sockPath };
}
