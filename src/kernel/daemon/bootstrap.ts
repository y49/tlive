// src/kernel/daemon/bootstrap.ts
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startIpcServer, type IpcServer } from '../ipc/server.js';
import { PermissionRouter, type PermChat } from './permission-router.js';
import { decide as policyDecide, type PolicyState } from '../permission/policy-engine.js';
import { renderApprovalCard } from '../permission/approval-renderer.js';
import { renderAskCard, askMultiButtons, type AskOption } from '../permission/ask-renderer.js';
import { AskSelection } from './ask-state.js';
import { createEditQueue } from './edit-queue.js';
import { ContinueBroker } from '../permission/continue-broker.js';
import { SenderGuard } from './sender-guard.js';
import { loadConfig } from '../config/loader.js';
import type { IMAdapter } from '../contracts/im-adapter.js';
import { SessionRegistry } from '../web/session-registry.js';
import { startWebServer, type WebServerHandle } from '../web/server.js';
import { loadOrCreateToken } from '../web/token.js';
import { EventHub } from '../web/event-hub.js';
import { applyMonitorEvent, sweepDeadSessions, pidAlive } from '../web/session-events.js';
import { ensureCodexAppServer, codexAppServerSockPath } from '../codex/spawn.js';
import { connectCodexRpc } from '../codex/rpc.js';
import { startCompanion, type Companion } from '../codex/companion.js';
import { excerptForCard } from './excerpt.js';
import { TURN_FINISHED_SENTINEL } from '../hook/normalizer.js';

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
  ensureAppServer?: typeof ensureCodexAppServer;
}

/** A Stop hook should not sit waiting when nothing can answer: no IM chat
 *  configured AND no dashboard client connected → reply null immediately. */
export function shouldFastNullContinue(chatCount: number, webClientCount: number): boolean {
  return chatCount === 0 && webClientCount === 0;
}

/** 该会话已挂着一张续跑卡(continueId 非空)时,idle notification(level=info)
 *  是重复 —— CC 在 turn 结束 60s 后会 fire 一条 "waiting for your input",而
 *  Turn finished 卡早就在等你了。只对 info 级去重;error 级(工具失败 /
 *  Stop 失败告警,见 hook.ts 的 level 判定)永不去重 —— continueId 只在
 *  broker resolve 时清空(最长 continueWindowSec,默认 30min),且
 *  'prompt' 事件(键盘前续跑)不清它,残留期间任何失败告警都不能被静默吞掉。
 *  用状态 + level 判断,不匹配 vendor 文案。 */
export function shouldDropNotify(continueId: string | null | undefined, level: 'info' | 'warn' | 'error'): boolean {
  return level === 'info' && Boolean(continueId);
}

/** Codex `turn/completed` → offer the reply to whoever's watching (IM/web) via
 *  ContinueBroker, then feed a non-null reply back into the thread via
 *  `turn/start`. Mirrors the `hook.continue.request` IPC handler minus the
 *  IPC reply — the ContinueBroker.onRequest handler already does the IM
 *  broadcast, so this only needs the session-upsert bookkeeping. Never throws
 *  — the companion notify path must not crash on a broker/resume failure. */
export function makeCodexResumeHandler(deps: {
  broker: Pick<ContinueBroker, 'request'>;
  sessions: SessionRegistry;
  events: Pick<EventHub, 'broadcast' | 'size'>;
  chats: () => unknown[];
  resume: (threadId: string, input: string) => Promise<void>;
}): (p: { threadId: string; key: string; lastMessage?: string }) => void {
  return (p) => {
    void (async () => {
      const { threadId, key, lastMessage } = p;
      if (shouldFastNullContinue(deps.chats().length, deps.events.size())) {
        deps.events.broadcast({
          type: 'session-upsert',
          session: deps.sessions.upsert({ key, cwd: key, status: 'idle', ...(lastMessage ? { lastMessage } : {}) }),
        });
        return;
      }
      deps.events.broadcast({
        type: 'session-upsert',
        session: deps.sessions.upsert({ key, cwd: key, status: 'waiting-input', ...(lastMessage ? { lastMessage } : {}) }),
      });
      const reply = await deps.broker.request({ cwd: key, context: lastMessage ?? TURN_FINISHED_SENTINEL, timeoutSec: 170 });
      if (reply) {
        deps.resume(threadId, reply).catch((e) => console.log('[codex] resume failed: ' + (e instanceof Error ? e.message : String(e))));
        deps.events.broadcast({ type: 'session-upsert', session: deps.sessions.upsert({ key, cwd: key, status: 'active', continueId: null }) });
      } else {
        deps.events.broadcast({ type: 'session-upsert', session: deps.sessions.upsert({ key, cwd: key, status: 'idle', continueId: null }) });
      }
    })().catch(() => undefined);
  };
}

/** Pending-approval window: absent = legacy 580s; capped at 24h (the CC
 *  permission-request channel asks for ~86000s). */
export function clampPermissionTimeout(timeoutSec: number | undefined): number {
  return Math.min(timeoutSec ?? 580, 86_400);
}

/** 续跑卡 body:摘录进 expandable 引用块,前后空行分段(B1)。
 *  body 前导 \n 是有意的 —— renderCard 只在 title 后放一个换行,这一个
 *  额外换行就是标题与正文之间的那道留白。 */
export function buildContinueCardBody(lastMessage: string): string {
  const ex = excerptForCard(lastMessage ?? '');
  const quote = ex ? ex.split('\n').map((l) => `>! ${l}`).join('\n') + '\n\n' : '';
  return `\n${quote}*Reply to continue*`;
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

  // Task 10 review Important fix: a multi-select card's toggle edit and its
  // eventual onResolved settlement edit both hit adapter.edit() (real network
  // I/O) for the same rid — nothing guarantees the settlement edit (always
  // fired LAST) lands last too. Route every edit for a rid through this
  // per-rid serial queue so landing order matches enqueue order, keeping the
  // "no zombie cards" invariant even under network reordering.
  const editQueue = createEditQueue();

  // AskUserQuestion (Task 9): raw question + options per pending requestId, so an
  // `ask:<rid>:<idx>` button click can build the deny+message answer. Written at
  // onPending, cleared at onResolved (or consumed once by the button click) —
  // never leaks across the request's lifetime.
  const askContexts = new Map<string, { question: string; options: AskOption[] }>();
  // Same lifetime as askContexts' *pending* window, but never consumed by the
  // button-click handler (askContexts is get-and-clear there) — lets onResolved
  // still know "this requestId was an ask card" after the answer already
  // cleared askContexts (Minor 4: label the IM card "Answered", not "Denied").
  const askRequestIds = new Set<string>();
  // Multi-select checkbox state (Task 10) — per-requestId picks, toggled by
  // asktoggle: (via inbound-handler), read/cleared by asksubmit:. Also freed
  // on askskip: and unconditionally in onResolved below (same no-leak
  // discipline as askContexts — covers defer/timeout/local-answer races that
  // never reach asksubmit:/askskip: at all).
  const askSelection = new AskSelection();

  /** `<label> · ` prefix. wrapped/hook-only 不再用图标区分 —— 续跑卡自带
   *  "Reply to continue" 引导,该区分对用户的实际操作没有影响。 */
  const sessionTag = (cwd: string | undefined): string => {
    if (!cwd) return '';
    const s = sessions.get(cwd);
    if (!s) return '';
    return `${s.label} · `;
  };

  const sendToChat = async (
    target: PermChat,
    msg: { title?: string; body?: string; text?: string; requestId?: string; toolName?: string; cwd?: string; askOptions?: AskOption[]; askMulti?: boolean },
  ): Promise<void> => {
    const adapter = (opts.imAdapters ?? []).find((a) => a.channel === target.channel);
    if (!adapter) return;
    const tag = sessionTag(msg.cwd);
    let sent: { messageId: string };
    if (msg.text !== undefined) {
      const text = `${tag}${msg.text}`;
      sent = await adapter.send({ kind: 'text', text });
    } else {
      const title = msg.title ? `${tag}${msg.title}` : undefined;
      const body = msg.body ?? '';
      sent = await adapter.send({
        kind: 'card',
        ...(title ? { title } : {}),
        body,
        // AskUserQuestion cards get option buttons instead of Allow/Deny (Task
        // 9); a multiSelect question gets checkboxes + Submit(N) + Skip
        // instead of the numbered single-pick buttons (Task 10). Freshly-sent
        // card always starts with an empty selection — askSelection has no
        // entry yet for a brand-new requestId.
        ...(msg.requestId ? { buttons: msg.askMulti
          ? askMultiButtons(msg.requestId, msg.askOptions ?? [], [])
          : msg.askOptions
          ? [
              ...msg.askOptions.map((o, i) => ({ id: `ask:${msg.requestId}:${i}`, label: `${i + 1}. ${o.label}` })),
              { id: `askskip:${msg.requestId}`, label: 'Skip' },
            ]
          : [
              { id: `approve:${msg.requestId}`, label: 'Allow' },
              { id: `deny:${msg.requestId}`, label: 'Deny' },
              ...(msg.toolName ? [{ id: `allowtool:${msg.requestId}:${msg.toolName}`, label: `Always allow ${msg.toolName}` }] : []),
              { id: `pause:${msg.requestId}`, label: 'Pause approvals' },
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

  const OUTCOME: Record<string, string> = { allow: 'Allowed', deny: 'Denied', defer: 'Timed out', local: 'Answered in terminal' };

  const permissionRouter = new PermissionRouter({
    configuredChats,
    sendToChat: (t, card) => sendToChat(t, card),
    isMuted: (cwd) => muted || (sessions.get(cwd)?.muted ?? false),
    hasWebClients: () => events.size() > 0,
    policyDecide: (req) => {
      const d = policyDecide({ toolName: req.toolName, permissionMode: req.permissionMode }, policyState);
      if (d.decision === 'allow') console.log(`[policy] auto-allow ${req.toolName} (${d.reason})`); // 审计
      return d;
    },
    renderCard: (req) => {
      // AskUserQuestion (Task 9) is CC-only and gets its own single-select
      // card instead of the generic diff/command renderer — malformed input
      // falls through to the normal approval card so CC reports its own error.
      if (req.toolName === 'AskUserQuestion') {
        const ask = renderAskCard(req.input);
        // ask.question (not a re-extraction from req.input) — renderAskCard
        // already validated it; a single source of truth (review Minor 5).
        if (ask) return { title: ask.title, body: ask.body, askOptions: ask.options, askQuestion: ask.question, askMulti: ask.multiSelect };
      }
      return renderApprovalCard({ toolName: req.toolName, input: req.input });
    },
    graceSec: () => Math.max(cfg.approvals?.approvalGraceSec ?? 10, 0),
    onPending: ({ cwd, requestId, title, body, toolName, askOptions, askQuestion }) => {
      if (askOptions && askQuestion) {
        askContexts.set(requestId, { question: askQuestion, options: askOptions });
        askRequestIds.add(requestId); // Task 9 review Minor 4: survives the button-click's askContexts consumption, so onResolved can still tell this was an ask card
        // Task 9 review Important: an AskUserQuestion card must NOT reach the
        // dashboard. /ws/events' onAction only understands generic approve/deny
        // (web/src/dashboard.ts renders plain Allow/Deny buttons for `pending`),
        // and deny-with-no-message would feed the agent a bogus "Denied via
        // tlive" answer to its own question. Before this feature, AskUserQuestion
        // auto-allowed at the policy layer and never reached onPending at all —
        // this restores that "invisible to web" behavior for the ask branch only.
        // IM still gets the card via sendToChat below (grace push), unaffected.
        // Full web support (message-carrying EventAction + option buttons) is a
        // follow-up task, not this fix.
        return;
      }
      // `cwd` here is the resolved registry key (see resolveKey).
      events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key: cwd, cwd, status: 'waiting-approval', pending: { requestId, title, body, toolName } }) });
    },
    onResolved: ({ cwd, requestId, decision }) => {
      askContexts.delete(requestId); // no leak whether consumed by a button click or resolved another way
      askSelection.clear(requestId); // no leak — covers defer/timeout/local-answer paths that skip asksubmit:/askskip: entirely (Task 10)
      const isAsk = askRequestIds.delete(requestId); // true only for an AskUserQuestion card (Minor 4)
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
          // 紧凑回写:结果 + 标题一行足够,不再重挂全 body(高卡变短讯)。
          // An ask card's wire mechanism IS a deny (see ask-renderer.ts file
          // header) even when the user picked an answer — label it "Answered"
          // so the user isn't scared into thinking their pick failed (Minor 4).
          const label = isAsk && decision === 'deny' ? 'Answered' : (OUTCOME[decision] ?? decision);
          // Queued (not a bare fire-and-forget edit) — this settlement edit is
          // always enqueued LAST for requestId, so it always lands last too,
          // even if an earlier toggle edit for the same rid is still in flight.
          void editQueue.enqueue(requestId, () => adapter.edit(c.messageId, { kind: 'card', title: `${label} · ${c.title}`, body: '' }));
        }
      }
    },
  });

  const continueBroker = new ContinueBroker();
  let latestContinueId: string | null = null;
  // key → cancel-grace:一个会话在续跑 grace 窗口内时,收到该会话的新 prompt
  // 就调用它取消发卡(用户在键盘前继续了)。
  const continueGrace = new Map<string, () => void>();

  continueBroker.onRequest((req) => {
    latestContinueId = req.requestId;
    // Thread the continue requestId into the session so a dashboard client can reply to it.
    events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key: req.cwd, cwd: req.cwd, status: 'waiting-input', continueId: req.requestId }) });
    if (muted || sessions.get(req.cwd)?.muted) return;
    for (const t of configuredChats()) {
      // requestId 不进显示文本:回复路由走 replyToMessageId,不解析正文。
      const raw = req.context === TURN_FINISHED_SENTINEL ? '' : req.context;
      void sendToChat(t, { title: 'Turn finished', body: buildContinueCardBody(raw), cwd: req.cwd });
    }
  });

  // Codex app-server companion: adopt-or-spawn custody + RPC subscription for
  // monitoring/approvals. Absent codex / win32 / spawn failure → 'off', purely
  // local (in-terminal) approvals still work; the daemon must never crash for this.
  let codexCompanion: Companion | null = null;
  let codexState: 'running' | 'degraded' | 'off' = 'off';
  const ensureAppServer = opts.ensureAppServer ?? ensureCodexAppServer;
  const custody = await ensureAppServer({
    logPath: join(opts.home, 'codex-appserver.log'),
    onStateChange: (s) => { codexState = s; },
  }).catch(() => null);
  // Indirection: onResumePrompt is needed at construction time, but resume()
  // only exists once startCompanion returns — close over this instead.
  let codexResume: (threadId: string, input: string) => Promise<void> = async () => undefined;
  const onCodexResumePrompt = makeCodexResumeHandler({
    broker: continueBroker,
    sessions,
    events,
    chats: configuredChats,
    resume: (threadId, input) => codexResume(threadId, input),
  });
  if (custody) {
    codexState = 'running';
    codexCompanion = startCompanion({
      connect: (events) => connectCodexRpc({ sockPath: codexAppServerSockPath(), events }),
      permissionRouter,
      onMonitor: (ev, key) => events.broadcast(applyMonitorEvent(sessions, ev, key)),
      onResumePrompt: onCodexResumePrompt,
      log: (m) => console.log(`[codex] ${m}`),
    });
    codexResume = (threadId, input) => codexCompanion!.resume(threadId, input);
  }

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
          reply({ kind: 'daemon.status', uptimeMs: Date.now() - startedAt, pid: process.pid, codex: codexState });
          return;
        case 'daemon.stop':
          reply({ kind: 'daemon.stopped' });
          setTimeout(() => { void shutdown(); }, 10).unref?.();
          return;
        case 'hook.permission.request': {
          const key = resolveKey(req.cwd, req.wrappedId);
          const r = await permissionRouter.requestPermission({
            cwd: key, toolName: req.toolName, input: req.input,
            permissionMode: req.permissionMode,
            timeoutSec: clampPermissionTimeout(req.timeoutSec),
            ...(req.sessionId ? { sessionId: req.sessionId } : {}),
            ...(req.agentId ? { agentId: req.agentId } : {}),
          });
          // 'local' (answered in the terminal) maps to 'defer' on the wire: the shim
          // outputs pass-through {} — a no-op for a dialog that is already gone.
          reply({
            kind: 'hook.permission.result',
            decision: r.decision === 'local' ? 'defer' : r.decision,
            ...(r.message ? { message: r.message } : {}),
          });
          return;
        }
        case 'hook.permission.answer':
          permissionRouter.answer(req.requestId, req.approved, req.message);
          reply({ kind: 'ack' });
          return;
        case 'hook.continue.request': {
          const key = resolveKey(req.cwd, req.wrappedId);
          // Stop = the turn ended; any still-pending approval card is stale.
          permissionRouter.cancel({ key });
          if (shouldFastNullContinue(configuredChats().length, events.size())) {
            // Nobody can answer (no IM chat, no dashboard client) — don't make
            // the Stop hook sit its full window for nothing.
            events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key, cwd: req.cwd, status: 'idle', ...(req.lastMessage ? { lastMessage: req.lastMessage } : {}) }) });
            reply({ kind: 'hook.continue.result', reply: null });
            return;
          }
          // Grace 门控:turn 刚结束,先等 graceSec —— 你要是在键盘前很快开始新
          // 一轮(UserPromptSubmit),就取消,不发续跑卡(消除刷屏);静默才推卡。
          // (async Stop hook 让 turn 立即结束,本 grace 不占用你的终端。)
          const graceSec = cfg.approvals?.continueGraceSec ?? 15;
          const suppressed = await new Promise<boolean>((res) => {
            continueGrace.set(key, () => res(true));
            setTimeout(() => { if (continueGrace.delete(key)) res(false); }, graceSec * 1000).unref();
          });
          if (suppressed) {
            events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key, cwd: req.cwd, status: 'active' }) });
            reply({ kind: 'hook.continue.result', reply: null });
            return;
          }
          events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key, cwd: req.cwd, status: 'waiting-input', ...(req.lastMessage ? { lastMessage: req.lastMessage } : {}) }) });
          // IM 摘录用真正的最后一句;没有才落回通用 context 文案。async Stop hook
          // 在后台等,窗口可以很长(默认 30min),覆盖"离开很久才看手机"。
          const continueWin = Math.min(Math.max(cfg.approvals?.continueWindowSec ?? 1800, 30), 86_400);
          const reply_text = await continueBroker.request({ cwd: key, context: req.lastMessage ?? req.context, timeoutSec: continueWin });
          // Resolved (replied or timed out): clear the reply target; back to active if continuing, else idle.
          events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key, cwd: req.cwd, status: reply_text ? 'active' : 'idle', continueId: null }) });
          reply({ kind: 'hook.continue.result', reply: reply_text });
          return;
        }
        case 'hook.notify': {
          const key = resolveKey(req.cwd, req.wrappedId);
          const s = sessions.get(key);
          // droppable(normalizer 判定"无实际错误内容",如 Bash 非零退出但
          // stderr 为空)只压 IM——dashboard 广播(下面的 events.broadcast)
          // 不受影响,始终照常:这条 attention 常是 dashboard 看到这次工具
          // 活动的唯一途径(PostToolUse/PostToolUseFailure 互斥,失败时没有
          // activity 事件替补)。Fix 3b:上一版把这个短路放在 shim 层,连
          // dashboard 一起吞了——落点错了,改回这里。
          if (!muted && !s?.muted && !shouldDropNotify(s?.continueId, req.level) && !req.droppable) {
            // cwd carries the resolved KEY so the label tag + reply-routing map are consistent.
            // 装饰性 emoji 一律不发;error 级别用 ⚠️(有信息量)。
            // normalizer 不再自带任何前缀(单一职责:只归一化文本)——
            // 前缀统一由这里按 level 决定;调用方若已手动带 ⚠️ 就不叠加。
            const text = req.message.startsWith('⚠️')
              ? req.message
              : req.level === 'error' ? `⚠️ ${req.message}` : req.message;
            await Promise.all(configuredChats().map((t) => sendToChat(t, { text, cwd: key })));
          }
          events.broadcast(applyMonitorEvent(sessions, { event: 'attention', cwd: req.cwd, sessionId: req.sessionId, message: req.message }, key));
          reply({ kind: 'ack' });
          return;
        }
        case 'hook.event': {
          const key = resolveKey(req.event.cwd, req.wrappedId);
          const ev = req.event;
          // Local terminal answered a permission dialog → release the parallel
          // remote card (CC dual-channel: PostToolUse = approved locally,
          // PermissionDenied = denied locally, a new prompt = dialog long gone).
          // sessionId/agentId narrow the match so sibling sub-agents sharing
          // key+tool keep their own pending cards.
          if (ev.event === 'activity') {
            // 精确关联:回答者身份(agent_id 缺失 = 主会话)必须与 pending 一致
            permissionRouter.cancel({ key, toolName: ev.toolName, sessionId: ev.sessionId, matchAgent: ev.agentId ?? null });
          } else if (ev.event === 'permission-denied') {
            permissionRouter.cancel({ key, toolName: ev.toolName, sessionId: ev.sessionId, matchAgent: null });
          } else if (ev.event === 'prompt') {
            // 清场:用户新输入意味着上一轮对话框(含子 agent 的)都没了
            permissionRouter.cancel({ key, sessionId: ev.sessionId });
            // 用户在键盘前开始了新一轮 → 取消上一 turn 还在 grace 里的续跑卡
            const g = continueGrace.get(key);
            if (g) { continueGrace.delete(key); g(); }
          }
          events.broadcast(applyMonitorEvent(sessions, ev, key));
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
        case 'session.activity': {
          // Terminal-derived running/idle — never overrides a hook-driven wait.
          const s = sessions.get(req.id);
          if (s && s.status !== 'waiting-approval' && s.status !== 'waiting-input') {
            events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key: s.id, cwd: s.cwd, status: req.active ? 'active' : 'idle' }) });
          }
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
    peekAskContext: (rid: string) => askContexts.get(rid),
    takeAskContext: (rid: string) => {
      const ctx = askContexts.get(rid);
      if (ctx) askContexts.delete(rid);
      return ctx;
    },
    askSelection,
    getAskCards: (rid: string) => sentCards.get(rid) ?? [],
    queueEdit: (rid, fn) => editQueue.enqueue(rid, fn),
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
      codexCompanion?.stop();
      custody?.stop();
      for (const a of opts.imAdapters ?? []) await a.stop();
      if (web) await web.close();
      await ipc.close();
    } finally {
      clearTimeout(forceExit);
    }
  }

  return { shutdown, permissionRouter, continueBroker, sessions, events, webUrl, ipcSocketPath: sockPath };
}
