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
import { applyMonitorEvent, sweepDeadSessions, pidAlive } from '../web/session-events.js';

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

  // Inbox housekeeping (uploaded attachments): sweep on startup AND hourly —
  // age limit + total-size cap, so it can never grow unbounded.
  const inboxDir = join(opts.home, 'inbox');
  const { sweepInbox } = await import('./inbox.js');
  sweepInbox(inboxDir);
  const inboxSweeper = setInterval(() => { sweepInbox(inboxDir); }, 3600_000);
  inboxSweeper.unref();

  let muted = false;
  const policyState: PolicyState = { trustUntilRevoked: false, allowTools: new Set<string>() };

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

  const sessions = new SessionRegistry();
  const events = new EventHub();

  /** Hook traffic → registry key: the wrapped session's uuid when the hook ran
   *  inside `tlive run` (TLIVE_SESSION), else cwd. We trust wrappedId even before
   *  session.register arrives — the shim only ever sets it inside `tlive run`, so
   *  keying by it (rather than falling back to cwd) avoids a phantom cwd-keyed
   *  card during the register race; register merges into the same uuid key. */
  const resolveKey = (cwd: string, wrappedId?: string): string => wrappedId ?? cwd;

  // IM messageId → session cwd, for reply-to routing (bounded; daemon-lifetime only).
  const msgToCwd = new Map<string, string>();
  const rememberMsg = (channel: string, messageId: string, cwd: string): void => {
    if (msgToCwd.size >= 500) {
      const oldest = msgToCwd.keys().next().value;
      if (oldest !== undefined) msgToCwd.delete(oldest);
    }
    msgToCwd.set(`${channel}:${messageId}`, cwd);
  };

  // Approval cards sent per requestId — edited to their outcome on resolve (no zombie buttons).
  const sentCards = new Map<string, Array<{ channel: string; messageId: string; title: string; body: string }>>();

  /** `[⌨ label]` for wrapped (injectable), `[label]` for hook-only sessions. */
  const sessionTag = (cwd: string | undefined): string => {
    if (!cwd) return '';
    const s = sessions.get(cwd);
    if (!s) return '';
    return s.kind === 'wrapped' ? `[⌨ ${s.label}] ` : `[${s.label}] `;
  };

  const sendToChat = async (
    target: PermChat,
    msg: { title?: string; body?: string; text?: string; requestId?: string; toolName?: string; cwd?: string },
  ): Promise<void> => {
    const adapter = (opts.imAdapters ?? []).find((a) => a.channel === target.channel);
    if (!adapter) return;
    const tag = sessionTag(msg.cwd);
    let sent: { messageId: string };
    if (msg.text !== undefined) {
      const text = `${tag}${msg.text}`;
      sent = await adapter.send({ kind: 'text', text: deepLink ? `${text}\n🔗 ${deepLink}` : text });
    } else {
      const title = msg.title ? `${tag}${msg.title}` : undefined;
      const body = deepLink ? `${msg.body ?? ''}\n🔗 ${deepLink}` : (msg.body ?? '');
      sent = await adapter.send({
        kind: 'card',
        ...(title ? { title } : {}),
        body,
        ...(msg.requestId ? {
          buttons: [
            { id: `approve:${msg.requestId}`, label: '✅ 允许' },
            { id: `deny:${msg.requestId}`, label: '❌ 拒绝' },
            ...(msg.toolName ? [{ id: `allowtool:${msg.requestId}:${msg.toolName}`, label: `✅ 总是允许 ${msg.toolName}` }] : []),
            { id: `pause:${msg.requestId}`, label: '⏸ 暂停审批' },
          ],
        } : {}),
      });
      if (msg.requestId) {
        const list = sentCards.get(msg.requestId) ?? [];
        list.push({ channel: target.channel, messageId: sent.messageId, title: title ?? '', body });
        sentCards.set(msg.requestId, list);
      }
    }
    if (msg.cwd) rememberMsg(target.channel, sent.messageId, msg.cwd);
  };

  // Reap wrapped sessions whose `tlive run` process died without unregistering (kill -9 / crash).
  const sweeper = setInterval(() => {
    for (const f of sweepDeadSessions(sessions, pidAlive)) events.broadcast(f);
  }, 30_000);
  sweeper.unref();

  const OUTCOME: Record<string, string> = { allow: '✅ 已允许', deny: '❌ 已拒绝', defer: '⏳ 已超时(回落本地)' };

  const permissionRouter = new PermissionRouter({
    configuredChats,
    sendToChat: (t, card) => sendToChat(t, card),
    isMuted: (cwd) => muted || (sessions.get(cwd)?.muted ?? false),
    policyDecide: (req) => {
      const d = policyDecide({ toolName: req.toolName, permissionMode: req.permissionMode }, policyState);
      if (d.decision === 'allow') console.log(`[policy] auto-allow ${req.toolName} (${d.reason})`); // 审计
      return d;
    },
    renderCard: (req) => renderApprovalCard({ toolName: req.toolName, input: req.input }),
    onPending: ({ cwd, requestId, title, body, toolName }) => {
      // `cwd` here is the resolved registry key (see resolveKey).
      events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key: cwd, cwd, status: 'waiting-approval', pending: { requestId, title, body, toolName } }) });
    },
    onResolved: ({ cwd, requestId, decision }) => {
      // Only touch the session view if THIS request still owns the pending slot —
      // with two concurrent approvals on one key, resolving A must not wipe B's
      // indicator (registry holds a single pending; B's card/router entry live on).
      if (sessions.get(cwd)?.pending?.requestId === requestId) {
        // Non-approved outcomes (deny/defer) leave the session idle; only allow → active.
        events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key: cwd, cwd, status: decision === 'allow' ? 'active' : 'idle', pending: null }) });
      }
      // Rewrite the IM cards to their outcome (buttons removed) — no zombie cards.
      const cards = sentCards.get(requestId);
      if (cards) {
        sentCards.delete(requestId);
        for (const c of cards) {
          const adapter = (opts.imAdapters ?? []).find((a) => a.channel === c.channel);
          if (!adapter) continue;
          void adapter.edit(c.messageId, { kind: 'card', title: `${OUTCOME[decision] ?? decision} · ${c.title}`, body: c.body }).catch(() => undefined);
        }
      }
    },
  });

  const continueBroker = new ContinueBroker();
  let latestContinueId: string | null = null;

  continueBroker.onRequest((req) => {
    latestContinueId = req.requestId;
    // Thread the continue requestId into the session so a dashboard client can reply to it.
    events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key: req.cwd, cwd: req.cwd, status: 'waiting-input', continueId: req.requestId }) });
    if (muted || sessions.get(req.cwd)?.muted) return;
    for (const t of configuredChats()) {
      void sendToChat(t, { text: `⏸ ${req.context}\n回复本条以续跑 (id: ${req.requestId})`, cwd: req.cwd });
    }
  });

  // Upstream actions from a dashboard client (/ws/events): approve/reply/mute.
  const onAction = (action: import('../web/event-hub.js').EventAction): void => {
    switch (action.type) {
      case 'approve':
        if (action.approved && action.alwaysAllowTool) policyState.allowTools?.add(action.alwaysAllowTool);
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
      case 'inject': {
        const s = sessions.get(action.id);
        if (s?.sockPath) {
          void import('./inject.js').then(({ injectInput }) => injectInput(s.sockPath!, action.text)).catch(() => undefined);
        }
        return;
      }
    }
  };

  let web: WebServerHandle | null = null;
  let webUrl: string | undefined;
  if (cfg.web?.enabled !== false) {
    // Default 0.0.0.0: phone access on the LAN is the core use case; the token gates every request.
    const bind = cfg.web?.bind ?? '0.0.0.0';
    const port = cfg.web?.port ?? 7681;
    const token = loadOrCreateToken(opts.home);
    const here = dirname(fileURLToPath(import.meta.url)); // dist/src
    const webDir = join(here, '..', 'web'); // dist/web (Plan 5)
    try {
      web = await startWebServer({ bind, port, token, sessions, events, onAction, inboxDir: join(opts.home, 'inbox'), webDir });
      webUrl = web.url;
      if (cfg.web?.publicUrl) deepLink = `${cfg.web.publicUrl.replace(/\/+$/, '')}/?token=${token}`;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`tlive web server failed to start: ${(e as Error).message}`);
    }
  }

  const senderGuard = new SenderGuard(cfg.allowedSenders);

  // Windows: the CLI/hook clients dial the named pipe (defaultSocketPath) —
  // the server must listen on the SAME endpoint, not a filesystem path.
  const sockPath = process.platform === 'win32' ? '\\\\.\\pipe\\tlive-daemon' : join(opts.home, 'daemon.sock');
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
          const key = resolveKey(req.cwd, req.wrappedId);
          const r = await permissionRouter.requestPermission({ cwd: key, toolName: req.toolName, input: req.input, permissionMode: req.permissionMode });
          reply({ kind: 'hook.permission.result', decision: r.decision });
          return;
        }
        case 'hook.permission.answer':
          permissionRouter.answer(req.requestId, req.approved);
          reply({ kind: 'ack' });
          return;
        case 'hook.continue.request': {
          const key = resolveKey(req.cwd, req.wrappedId);
          events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key, cwd: req.cwd, status: 'waiting-input', ...(req.lastMessage ? { lastMessage: req.lastMessage } : {}) }) });
          const reply_text = await continueBroker.request({ cwd: key, context: req.context, timeoutSec: 170 });
          // Resolved (replied or timed out): clear the reply target; back to active if continuing, else idle.
          events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key, cwd: req.cwd, status: reply_text ? 'active' : 'idle', continueId: null }) });
          reply({ kind: 'hook.continue.result', reply: reply_text });
          return;
        }
        case 'hook.notify': {
          const key = resolveKey(req.cwd, req.wrappedId);
          if (!muted && !sessions.get(key)?.muted) {
            // cwd carries the resolved KEY so the [⌨ label] tag + reply-routing map are consistent.
            await Promise.all(configuredChats().map((t) => sendToChat(t, { text: `[${req.level}] ${req.message}`, cwd: key })));
          }
          events.broadcast(applyMonitorEvent(sessions, { event: 'attention', cwd: req.cwd, sessionId: req.sessionId, message: req.message }, key));
          reply({ kind: 'ack' });
          return;
        }
        case 'hook.event': {
          events.broadcast(applyMonitorEvent(sessions, req.event, resolveKey(req.event.cwd, req.wrappedId)));
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

  const { injectInput } = await import('./inject.js');
  const inbound = new (await import('./inbound-handler.js')).InboundHandler({
    senderGuard,
    imBy: (ch) => (opts.imAdapters ?? []).find((a) => a.channel === ch),
    permissionRouter,
    continueBroker,
    takeLatestContinueId: () => { const id = latestContinueId; latestContinueId = null; return id; },
    setMuted: (m: boolean) => { muted = m; },
    setTrust: (t: boolean) => { policyState.trustUntilRevoked = t; },
    addAllowTool: (tool: string) => { policyState.allowTools?.add(tool); },
    resolveReply: (channel, messageId) => msgToCwd.get(`${channel}:${messageId}`),
    sessionInfo: (cwd) => {
      const s = sessions.get(cwd);
      if (!s) return undefined;
      return { kind: s.kind, label: s.label, ...(s.sockPath ? { sockPath: s.sockPath } : {}), ...(s.continueId ? { continueId: s.continueId } : {}) };
    },
    listSessions: () => sessions.list().map((s) => ({ cwd: s.cwd, kind: s.kind, label: s.label, ...(s.sockPath ? { sockPath: s.sockPath } : {}) })),
    inject: (sockPath, text) => injectInput(sockPath, text),
  });
  for (const a of opts.imAdapters ?? []) {
    await a.start();
    a.onInbound((env) => { void inbound.handle(env); });
  }

  let stopped = false;
  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;
    clearInterval(sweeper);
    clearInterval(inboxSweeper);
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
