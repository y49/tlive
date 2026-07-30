// src/kernel/daemon/bootstrap.ts
import { join, dirname } from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startIpcServer, type IpcServer } from '../ipc/server.js';
import { daemonSocketPath } from '../ipc/client.js';
import { PermissionRouter, type PermChat } from './permission-router.js';
import { decide as policyDecide, type PolicyState } from '../permission/policy-engine.js';
import { renderApprovalCard } from '../permission/approval-renderer.js';
import { parseAskBatch, renderAskBody, askButtons, extractAskAnswer, type AskBatch } from '../permission/ask-renderer.js';
import { AskFlow } from './ask-flow.js';
import type { AskContext } from './permission-router.js';
import { createEditQueue } from './edit-queue.js';
import { createDesktopNotifier } from './desktop-notify.js';
import { LocalPrompts } from './local-prompts.js';
import { ContinueBroker } from '../permission/continue-broker.js';
import { SenderGuard } from './sender-guard.js';
import { loadConfig } from '../config/loader.js';
import { approvalWindow } from '../config/window.js';
import type { IMAdapter } from '../contracts/im-adapter.js';
import { SessionRegistry, type SessionView } from '../web/session-registry.js';
import { startWebServer, type WebServerHandle } from '../web/server.js';
import { loadOrCreateToken } from '../web/token.js';
import { EventHub } from '../web/event-hub.js';
import { applyMonitorEvent, sweepDeadSessions, pidAlive } from '../web/session-events.js';
import { ensureCodexAppServer, codexAppServerSockPath } from '../codex/spawn.js';
import { connectCodexRpc } from '../codex/rpc.js';
import { startCompanion, type Companion } from '../codex/companion.js';
import { excerptForCard } from './excerpt.js';
import { TURN_FINISHED_SENTINEL, effectiveMode, type ShimMode } from '../hook/normalizer.js';
import { writeMode } from '../config/mode.js';

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
  /** Test seam for the desktop notifier; production uses createDesktopNotifier. */
  desktopNotifier?: import('./desktop-notify.js').DesktopNotifier;
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

/** Hook 流量 → registry key。**每个会话一个 key,不是每个目录一个**:
 *  wrapped 用 `tlive run` 的 uuid;hook-only 用 vendor 的会话 id
 *  (CC 的 session_id / Codex 的 codex:<threadId>)。sessionId 缺失才落回 cwd。
 *  用 cwd 当 key 会让同目录的两个会话共享一条记录 —— 后者的 continueId
 *  会覆盖前者,前者的续跑卡就此失联(真 bug)。
 *  cwd 仍作为 registry 的字段传入,label = basename(cwd) 因此仍是项目名。 */
export const resolveKey = (sessionId: string, cwd: string, wrappedId?: string): string =>
  wrappedId ?? (sessionId || cwd);

/** stale 卡点击的告知文案。救不回来是物理事实(shim 已死),让用户以为点成功
 *  了才是产品在撒谎。覆盖:daemon 重启 / 已超时 / 会话已结束。 */
export const STALE_CARD_NOTICE =
  'This request is no longer active — the session ended, timed out, or tlive restarted. Answer at the keyboard.';

/** 续跑卡 body:摘录进 expandable 引用块,前后空行分段(B1)。
 *  body 前导 \n 是有意的 —— renderCard 只在 title 后放一个换行,这一个
 *  额外换行就是标题与正文之间的那道留白。 */
export function buildContinueCardBody(lastMessage: string): string {
  const ex = excerptForCard(lastMessage ?? '');
  const quote = ex ? ex.split('\n').map((l) => `>! ${l}`).join('\n') + '\n\n' : '';
  // Quote-reply is the continue path (the on-card input box was removed) — the
  // hint spells it out because quote-reply is not obvious, esp. on Feishu.
  return `\n${quote}*Reply to this message to continue.*`;
}

/** One structured line per diagnostic event, on the daemon's stdout (captured to
 *  ~/.tlive/daemon.log). Deliberately not a logging framework: the whole point is
 *  that `tlive daemon-logs` stays greppable JSON with a stable `msg` per event.
 *
 *  Callers pass identity fields ONLY. Tool inputs, prompts, message bodies and
 *  card text never belong here — the log is shared across every session on the
 *  machine and any of those can carry secrets. */
function logJson(msg: string, fields: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, ...fields }));
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
  const policyState: PolicyState = {
    trustUntilRevoked: false,
    allowTools: new Set<string>(),
    // Absent = off. Anything auto-allowed here removes a dialog CC was about to
    // show (PermissionRequest fires only on the ask path), so opting in is the
    // user's call — see policy-engine's READ_ONLY_TOOLS note.
    ...(cfg.approvals?.autoApprove ? { autoApprove: cfg.approvals.autoApprove } : {}),
  };

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

  // IM messageId → registry key, for reply-to routing (bounded; daemon-lifetime only).
  const msgToKey = new Map<string, string>();
  const rememberMsg = (channel: string, messageId: string, key: string): void => {
    if (msgToKey.size >= 500) {
      const oldest = msgToKey.keys().next().value;
      if (oldest !== undefined) msgToKey.delete(oldest);
    }
    msgToKey.set(`${channel}:${messageId}`, key);
  };

  // Approval cards sent per requestId — edited to their outcome on resolve (no
  // zombie buttons). `title`/`body` track the card's CURRENT contents, not the
  // ones it was born with: a multi-question ask repaints as its cursor moves,
  // and the settlement edit further down rebuilds from these fields. `tag` is
  // the `<label> · ` prefix, kept so a repaint can rebuild the title without
  // re-deriving it (the router hands sendToChat the session KEY as `cwd`, so
  // guessing wrong here silently drops the prefix).
  const sentCards = new Map<string, Array<{ channel: string; messageId: string; title: string; body: string; tag: string }>>();

  /** IM messageId → still-live approval requestId, or null. sentCards is deleted
   *  the instant onResolved fires (see below), so "findable" IS "still live" —
   *  same judgment-free philosophy as pending.has() in permission-router.ts,
   *  zero new state needed (Task 7). */
  const findLiveCard = (channel: string, messageId: string): string | null => {
    for (const [rid, cards] of sentCards) {
      if (cards.some((c) => c.channel === channel && c.messageId === messageId)) return rid;
    }
    return null;
  };

  // Task 10 review Important fix: a multi-select card's toggle edit and its
  // eventual onResolved settlement edit both hit adapter.edit() (real network
  // I/O) for the same rid — nothing guarantees the settlement edit (always
  // fired LAST) lands last too. Route every edit for a rid through this
  // per-rid serial queue so landing order matches enqueue order, keeping the
  // "no zombie cards" invariant even under network reordering.
  const editQueue = createEditQueue();

  // Desktop notification: the at-the-computer pointer to the phone card /
  // dashboard, for background-launched tool calls that render no local dialog
  // while the hook pends. Never carries a decision (never-auto-allow intact).
  // Click-to-answer: the toast carries an "Open dashboard" button — the
  // notification is an entrance, not just a pointer (background terminal
  // workflow: get pinged, click, approve, back to whatever you were doing).
  // webUrl is assigned when the web server starts below; clicks only happen
  // after bootstrap completes, so the lazy read is safe. Web disabled → no
  // URL to open; the click is a silent no-op (toast still informs).
  // Runtime gate (config seeds it; /desktop on|off flips it live). The
  // notifier itself is created enabled so a config-off start can still be
  // switched on without a restart.
  let desktopOn = cfg.approvals?.desktopNotify ?? true;
  /** 姿态是 config-backed 的(shim 每个 hook 事件都重读),所以 daemon 绝不能
   *  缓存它:`tlive mode all` 或 IM 的 /mode 必须改变**下一次**审批的行为,不需要
   *  重启。此前 cfg 只在 bootstrap 读一次,子代理分支于是永远停在启动时的姿态。
   *
   *  文件缺失 ≠ 读不出来,两者故意分两条路:文件不存在时 loadConfig 走正常的
   *  DEFAULT 分支(不抛),cfg.mode 是 undefined,effectiveMode 落到 'notify' ——
   *  这和 shim 的 readMode() 对同一份(缺席的)config.json 算出来的结果完全一样
   *  (single source of truth,两边不会因为文件在不在而分裂)。而且这条路根本
   *  摸不到:modeShortCircuit 一旦解出 'notify' 就在 IPC 之前把 permission-request
   *  短路成 `{}`,daemon 这一层永远收不到那次请求,所以这里返回什么都不影响真实
   *  的 hook 链路,只有绕开 shim 直接打 IPC 的调用方(如测试)才会观察到它。
   *  catch 分支管的是另一种情形——文件在但 JSON.parse 抛了(写到一半/写坏)——
   *  这才回落到启动时的 cfg.mode,当一次性的抗抖动,不是"删了配置就该记住上次
   *  姿态"。 */
  const currentMode = (): ShimMode => {
    try { return effectiveMode(loadConfig(opts.home).mode); } catch { return effectiveMode(cfg.mode); }
  };
  const desktop = opts.desktopNotifier ?? createDesktopNotifier({
    action: {
      label: 'Open dashboard',
      run: () => {
        if (!webUrl) return;
        try { spawnChild('xdg-open', [webUrl], { detached: true, stdio: 'ignore' }).unref(); } catch { /* best-effort */ }
      },
    },
  });

  // CC-native dialogs tlive is NOT holding, known only via
  // Notification(permission_prompt): notify mode, or a full-mode immediate
  // defer (issue #49). Drives the same waiting surfaces as a held card
  // (desktop toast / read-only dashboard card / graced IM text) minus any
  // answer path — the answer happens at the terminal, and the local-answer
  // triggers below (activity / permission-denied / prompt / session-end)
  // retire the entry exactly like they release held cards.
  const localPrompts = new LocalPrompts();
  /** The tracked dialog is gone (answered locally / new prompt / session end):
   *  drop the read-only pending from the registry and close the toast when
   *  nothing else waits. The registry upsert is silent — the caller's own
   *  broadcast (applyMonitorEvent) carries the merged view in the same frame. */
  const clearLocalPrompt = (key: string, sessionId: string | undefined, cwd: string): void => {
    if (!localPrompts.clear({ key, ...(sessionId ? { sessionId } : {}) })) return;
    if (sessions.get(key)?.pending?.local) sessions.upsert({ key, cwd, pending: null });
    if (nothingWaiting()) void desktop.clear();
  };

  // Same lifetime as the ask flow's *pending* window, but never consumed by an
  // answer (the flow deletes its entry the moment the last question lands) —
  // lets onResolved still know "this requestId was an ask card" afterwards
  // (Minor 4: label the IM card "Answered", not "Denied").
  const askRequestIds = new Set<string>();
  // AskUserQuestion progress per pending requestId: the parsed batch, which
  // question the cursor is on, the answers gathered so far and the current
  // question's checkbox picks. Started in onPending, consumed the moment the
  // last question is answered, and freed unconditionally in onResolved below
  // — that last one covers the defer/timeout/local-answer races that never
  // reach asksubmit:/askskip: at all, so nothing leaks past a request's
  // pending window.
  const askFlow = new AskFlow();
  // requestId → the session that owns it, so repaintAsk can re-broadcast the
  // dashboard card without threading key/cwd through every call site.
  const askOwner = new Map<string, { key: string; cwd: string }>();

  /** The dashboard's view of one question. `index`/`total` drive the "2/3"
   *  progress badge; a single-question batch renders exactly as before. */
  const askView = (batch: AskBatch, cursor: number): NonNullable<SessionView['pending']>['ask'] => {
    const q = batch.questions[cursor];
    return {
      question: q.question, ...(q.header ? { header: q.header } : {}),
      options: q.options, multiSelect: q.multiSelect,
      index: cursor, total: batch.questions.length,
    };
  };

  /** Repaint every surface at the flow's current cursor — the IM cards already
   *  sent AND the dashboard session card. The daemon owns the cursor, so both
   *  must move together: answering a question on your phone has to advance the
   *  dashboard, and vice versa. Called for every `render` step, wherever the
   *  interaction came in.
   *
   *  Enqueue every card's edit SYNCHRONOUSLY, in this same tick — mirrors the
   *  onResolved settlement loop (`void editQueue.enqueue`, no per-card await).
   *  Multi-channel review Important fix: awaiting each enqueue one at a time
   *  left the loop suspended on a slow channel before it reached a faster
   *  channel's card; an answer arriving during that await fires onResolved,
   *  whose settlement edits then land FIRST on the fast channel, and this
   *  repaint lands after — resurrecting a live question on top of an already
   *  "Answered" card (a zombie-card regression visible only with 2+ channels).
   *
   *  Feishu 真机反馈:重画时必须带上 ask 布局 + inputAction,否则 adapter 按
   *  通用 body 重渲,输入框就没了。 */
  const repaintAsk = (requestId: string): void => {
    const state = askFlow.peek(requestId);
    if (!state) return;
    const { batch, cursor, picks } = state;
    const q = batch.questions[cursor];
    const { title, body } = renderAskBody(batch, cursor);
    const buttons = askButtons(requestId, batch, cursor, picks);
    const inputAction = q.multiSelect
      ? { id: `asksubmit:${requestId}`, placeholder: 'Type something (optional — sent with your ticks)', submitLabel: 'Submit' }
      : { id: `askinput:${requestId}`, placeholder: 'Type your own answer', submitLabel: 'Send' };
    const askPayload = { question: q.question, ...(q.header ? { header: q.header } : {}), options: q.options, multiSelect: q.multiSelect };
    for (const card of sentCards.get(requestId) ?? []) {
      // Write the new contents BACK onto the stored card. Editing with the
      // stored title left the progress badge frozen at "Question 1/2" while
      // the body and buttons moved on, and the settlement edit below rebuilds
      // from these same fields — so a stale entry outlives the repaint.
      card.title = `${card.tag}${title}`;
      card.body = body;
      const adapter = (opts.imAdapters ?? []).find((a) => a.channel === card.channel);
      if (!adapter) continue;
      void editQueue.enqueue(requestId, () => adapter.edit(card.messageId, { kind: 'card', title: card.title, body: card.body, buttons, ask: askPayload, inputAction }));
    }
    const owner = askOwner.get(requestId);
    if (!owner) return;
    const view = sessions.get(owner.key);
    if (view?.pending?.requestId !== requestId) return;
    events.broadcast({ type: 'session-upsert', session: sessions.upsert({
      key: owner.key, cwd: owner.cwd, status: 'waiting-approval',
      pending: { ...view.pending, title, body, ask: askView(batch, cursor) },
    }) });
  };

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
    msg: { title?: string; body?: string; text?: string; requestId?: string; toolName?: string; cwd?: string; ask?: AskContext; agentId?: string; buttons?: Array<{ id: string; label: string }>; onSent?: (s: { channel: string; messageId: string }) => void },
  ): Promise<void> => {
    const adapter = (opts.imAdapters ?? []).find((a) => a.channel === target.channel);
    if (!adapter) return;
    const tag = sessionTag(msg.cwd);
    let sent: { messageId: string };
    if (msg.text !== undefined) {
      const text = `${tag}${msg.text}`;
      sent = await adapter.send({ kind: 'text', text });
    } else {
      // A HELD sub-agent card (agentId present) has no parallel terminal dialog
      // while it's held — unlike a main-session card, answering remotely is the
      // only way (short of handing it back). Mark it as such, matching the
      // pass-through notice's own `${toolName} · sub-agent` idiom, so the two
      // never read as indistinguishable. Tag prefix behaviour is unchanged:
      // tag still comes first, this only appends after the title.
      const title = msg.title ? `${tag}${msg.title}${msg.agentId ? ' · sub-agent' : ''}` : undefined;
      const body = msg.body ?? '';
      sent = await adapter.send({
        kind: 'card',
        ...(title ? { title } : {}),
        body,
        // AskUserQuestion cards get option buttons instead of Allow/Deny; a
        // multiSelect question gets checkboxes + Submit(N). A freshly sent
        // card is always at the batch's first question with nothing ticked —
        // every later repaint goes through inbound-handler's editAskCards.
        // Explicit buttons win (the pass-through notice has no requestId yet must
        // still carry its one-tap posture switch). Otherwise: the standard set,
        // plus — for a HELD sub-agent, whose terminal dialog does not exist while
        // we hold it — a way to get that dialog back and a way to stop holding
        // sub-agents at all.
        ...(msg.buttons ? { buttons: msg.buttons } : msg.requestId ? { buttons: msg.ask
          ? askButtons(msg.requestId, msg.ask.batch, 0, [])
          : [
              { id: `approve:${msg.requestId}`, label: 'Allow' },
              { id: `deny:${msg.requestId}`, label: 'Deny' },
              // Payload is requestId-only — the tool name goes in the LABEL, not
              // the callback data, which Telegram caps at 64 bytes and over which
              // it rejects the entire card. The daemon resolves the name from the
              // pending request (permissionRouter.toolNameFor).
              ...(msg.toolName ? [{ id: `allowtool:${msg.requestId}`, label: `Always allow ${msg.toolName}` }] : []),
              { id: `pause:${msg.requestId}`, label: 'Pause approvals' },
              ...(msg.agentId ? [
                { id: `handback:${msg.requestId}`, label: 'Answer at the terminal instead' },
                { id: 'mode:full', label: 'Stop holding sub-agents' },
              ] : []),
            ],
        } : {}),
        ...(msg.ask && msg.requestId ? (() => {
          // Channels with a native input (Feishu form) get ONE submit. multi →
          // the form submit IS the Submit (id = asksubmit:<rid>): typed text
          // and ticked boxes travel together, no second button (live feedback:
          // Submit + Send side by side read as two competing actions).
          // single → typed text answers directly (askinput:<rid>).
          const q = msg.ask.batch.questions[0];
          return {
            ask: { question: q.question, ...(q.header ? { header: q.header } : {}), options: q.options, multiSelect: q.multiSelect },
            inputAction: q.multiSelect
              ? { id: `asksubmit:${msg.requestId}`, placeholder: 'Type something (optional — sent with your ticks)', submitLabel: 'Submit' }
              : { id: `askinput:${msg.requestId}`, placeholder: 'Type your own answer', submitLabel: 'Send' },
          };
        })() : {}),
      });
      if (msg.requestId) {
        const list = sentCards.get(msg.requestId) ?? [];
        list.push({ channel: target.channel, messageId: sent.messageId, title: title ?? '', body, tag });
        sentCards.set(msg.requestId, list);
      }
    }
    if (msg.cwd) rememberMsg(target.channel, sent.messageId, msg.cwd);
    // Reported rather than returned: the return type is part of the router's dep
    // contract (Promise<void>), and only this one caller needs the id back.
    msg.onSent?.({ channel: target.channel, messageId: sent.messageId });
  };

  /** Sub-agent pass-through notices, so each can retire itself when that
   *  sub-agent's tool actually runs. Keyed by (key, agentId, toolName) — the one
   *  pair carried by BOTH the pass-through and the later PostToolUse, verified on
   *  a live session. Kept separate from `sentCards` on purpose: these carry no
   *  requestId, answer nothing, and must stay out of the reply-routing and
   *  stale-card machinery that indexes real approvals. */
  const passthruNotices = new Map<string, Array<{ channel: string; messageId: string; body: string }>>();
  const passthruKey = (key: string, agentId: string, toolName: string): string => `${key}\u0000${agentId}\u0000${toolName}`;

  /** requestId for the dashboard's read-only pending card on a pass-through. */
  const passthruRequestId = (agentId: string, toolName: string): string => `passthru:${agentId}:${toolName}`;

  /** Sub-agent dialogs handed back to the terminal and not yet observed running.
   *  Separate from passthruNotices (which only has entries when an IM card was
   *  actually sent) because the desktop toast must work with no IM at all — this
   *  is what lets retirePassthruNotice close the toast even when there was never
   *  a card to edit. */
  const passthruWaiting = new Set<string>(); // passthruKey(key, agentId, toolName)

  /** The single "is anything at all waiting for the user" predicate behind the
   *  desktop toast's lifetime. THREE surfaces feed it today (a held approval /
   *  a tracked CC-native local prompt / an outstanding sub-agent pass-through)
   *  and every one of them MUST be represented here — this used to be three
   *  separate copies of the same condition, and the copy at two of the three
   *  call sites silently forgot passthruWaiting, so a main-session approval
   *  resolving (or a local prompt clearing) anywhere closed a still-waiting
   *  sub-agent's toast. The next surface that gets its own waiting-tracker
   *  must be added HERE, not at whichever call site happens to need it. */
  const nothingWaiting = (): boolean =>
    permissionRouter.pendingCount() === 0 && localPrompts.count() === 0 && passthruWaiting.size === 0;

  /** The sub-agent's tool ran, so its dialog was answered at the keyboard. Mark
   *  the notice so it stops reading as "still waiting", clear its read-only
   *  dashboard card, and close the desktop toast once nothing else is waiting. */
  const retirePassthruNotice = (key: string, cwd: string, agentId: string, toolName: string): void => {
    const id = passthruKey(key, agentId, toolName);
    passthruWaiting.delete(id);
    // Same guard as onResolved: only clear the registry's ONE pending slot if
    // THIS notice still owns it — a main-session held approval (or a
    // different pass-through that raced in) must survive untouched. Silent —
    // no self-broadcast: this event's own hook.event handler broadcasts the
    // merged view right after (mirrors clearLocalPrompt's doc comment above).
    if (sessions.get(key)?.pending?.requestId === passthruRequestId(agentId, toolName)) {
      sessions.upsert({ key, cwd, pending: null });
    }
    if (nothingWaiting()) void desktop.clear();
    const notices = passthruNotices.get(id);
    if (!notices) return;
    passthruNotices.delete(id);
    for (const n of notices) {
      const adapter = (opts.imAdapters ?? []).find((a) => a.channel === n.channel);
      if (!adapter) continue;
      void adapter.edit(n.messageId, {
        kind: 'card',
        title: `${toolName} · sub-agent · ran at the terminal`,
        // n.body is the BASE body only (onPassthrough stores it without the
        // "waiting" suffix) — the title now says the tool ran, so the body
        // must not still claim it's waiting (cards must not lie). The tool
        // name/input in the base body is kept, not dropped, so you can still
        // see what ran.
        body: n.body,
      }).catch(() => undefined);
    }
  };

  // Reap wrapped sessions whose `tlive run` process died without unregistering (kill -9 / crash).
  const sweeper = setInterval(() => {
    for (const f of sweepDeadSessions(sessions, pidAlive)) events.broadcast(f);
  }, 30_000);
  sweeper.unref();

  const OUTCOME: Record<string, string> = { allow: 'Allowed', deny: 'Denied', defer: 'Timed out', local: 'Answered in terminal', gone: 'Session ended', handback: 'Handed back to the terminal' };

  const permissionRouter = new PermissionRouter({
    configuredChats,
    sendToChat: (t, card) => sendToChat(t, card),
    isMuted: (key) => muted || (sessions.get(key)?.muted ?? false),
    hasWebClients: () => events.size() > 0,
    // The desktop approval toast IS an answer path when it can open a dashboard
    // (its "Open dashboard" button needs a web URL). So muting IM no longer
    // forces a defer-to-terminal: with desktop on + web enabled, you answer via
    // the toast → dashboard. (IM ⊥ desktop.)
    hasLocalAnswerPath: () => desktopOn && webUrl != null,
    policyDecide: (req) => {
      const d = policyDecide({ toolName: req.toolName, input: req.input, permissionMode: req.permissionMode }, policyState);
      if (d.decision === 'allow') console.log(`[policy] auto-allow ${req.toolName} (${d.reason})`); // 审计
      return d;
    },
    renderCard: (req) => {
      // AskUserQuestion (Task 9) is CC-only and gets its own single-select
      // card instead of the generic diff/command renderer — malformed input
      // falls through to the normal approval card so CC reports its own error.
      if (req.toolName === 'AskUserQuestion') {
        const batch = parseAskBatch(req.input);
        // The whole batch travels together with the raw input: a call can hold
        // several questions, and the answer is built by spreading that input.
        if (batch) return { ...renderAskBody(batch, 0), ask: { batch, input: req.input } };
      }
      return renderApprovalCard({ toolName: req.toolName, input: req.input });
    },
    graceSec: () => Math.max(cfg.approvals?.approvalGraceSec ?? 10, 0),
    // Sub-agents pass through on 'full' (tlive transparent — no tlive-introduced
    // block); the 'all' rung opts into holding + remotely answering them, at the
    // cost of their terminal dialog. See permission-router's holdSubagents doc.
    holdSubagents: () => currentMode() === 'all',
    // Opt-in: on a held approval's timeout, deny (→ turn ends → continue card can
    // redirect) instead of the default defer (→ CC-native local fallback).
    timeoutAction: () => cfg.approvals?.timeoutAction ?? 'defer',
    log: logJson,
    // A sub-agent's approval was handed back to CC (its terminal dialog is what
    // answers it). Say what is blocked while we still know — CC's own
    // permission_prompt notification carries no tool name and no agentId, so it
    // could never say this, which is why full mode drops it. Deliberately NO
    // requestId: sendToChat only attaches Allow/Deny when one is present, and an
    // affordance that cannot work is worse than none (see onPassthrough).
    onPassthrough: ({ key, cwd, agentId, toolName, title, body }) => {
      logJson('permission.passthrough.notice', { key, agentId, toolName });
      void title; // the IM/dashboard titles below are the sub-agent-specific "<tool> · sub-agent", not the generic card title
      passthruWaiting.add(passthruKey(key, agentId, toolName));
      // A sub-agent pass-through can be the FIRST thing the daemon ever hears
      // about this session (e.g. right after a daemon restart) — register it
      // before the desktop ping below renders a `sessionTag(key)` label, same
      // fix as hook.notify's. The guard skips a no-op write for an already-known
      // session (upsert's patch merge would preserve its state either way).
      if (!sessions.get(key)) sessions.upsert({ key, cwd });
      // Desktop toast: the "at this machine, not watching the terminal" signal.
      // Gated ONLY by desktopOn — never by IM mute (IM ⊥ desktop), so it fires
      // with no IM configured at all, exactly like onPending's ping below.
      if (desktopOn) void desktop.ping(`${sessionTag(key)}${toolName} · sub-agent`, 'Waiting at the terminal — answer it there.');
      // Dashboard: read-only pending (local: true) — there is no held request
      // behind this, so Allow/Deny would be a button that cannot work (same
      // rule as the notify-mode local-prompt card). ONE pending slot per
      // session key: never evict an already-held main-session approval.
      if (!sessions.get(key)?.pending) {
        events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key, cwd, status: 'waiting-approval', pending: {
          requestId: passthruRequestId(agentId, toolName), title: `${toolName} · sub-agent`, body, local: true,
        } }) });
      }
      // IM card stays mute-gated (/mute is IM-only) — the desktop toast and
      // dashboard card above must fire regardless of it.
      if (!(muted || sessions.get(key)?.muted)) {
        // The waiting sentence is appended only to THIS live notice — the
        // suffix is not stored below. retirePassthruNotice's edit reuses the
        // stored base `body`, so once the title says the tool ran, the body
        // does not keep contradicting it by still saying "waiting" (cards
        // must not lie). The base body itself (tool + input) is kept, not
        // dropped, so the retired card still shows what ran.
        //
        // *…*, not _..._: telegram-html.ts deliberately does not support
        // underscore emphasis (ordinary snake_case/file_path content would
        // turn italic), so the raw underscores used to leak into the message
        // verbatim (real Telegram screenshot). `*single*` is what the
        // renderer actually converts to <i>.
        const notice = `${body}\n\n*Waiting at the terminal — a sub-agent's prompt can only be answered there.*`;
        for (const t of configuredChats()) {
          void sendToChat(t, {
            title: `${toolName} · sub-agent`, body: notice, cwd: key,
            // The one gap this notice cannot close: THIS dialog can only be answered
            // at the keyboard. What it can do is stop the next one from being lost —
            // one tap moves the posture up so the rest of this run comes to you.
            buttons: [{ id: 'mode:all', label: 'Hold sub-agents from now on' }],
            onSent: (s) => {
              const id = passthruKey(key, agentId, toolName);
              const list = passthruNotices.get(id) ?? [];
              list.push({ channel: s.channel, messageId: s.messageId, body }); // base body — no "waiting" suffix
              passthruNotices.set(id, list);
            },
          })
            .catch((e: unknown) => {
              logJson('permission.passthrough.undelivered', { key, agentId, toolName, channel: t.channel, error: e instanceof Error ? e.message : String(e) });
            });
        }
      }
    },
    onPending: ({ key, cwd, requestId, title, body, toolName, ask }) => {
      // A permission request can be the FIRST thing the daemon ever hears
      // about this session (e.g. right after a daemon restart) — register it
      // before the desktop ping below renders a `sessionTag(key)` label, same
      // fix as hook.notify's and onPassthrough's. The guard skips a no-op write
      // for an already-known session (upsert's patch merge preserves its state
      // either way); the final upsert below still carries the full
      // status/pending patch.
      if (!sessions.get(key)) sessions.upsert({ key, cwd });
      // Desktop ping FIRST — this notification is for the person AT this
      // machine, so it must be immediate (the IM card's grace delay exists to
      // spare the phone when you answer at the keyboard — delaying the local
      // pointer by the same 10s was backwards) and must not depend on any IM
      // channel being configured. onPending fires exactly once per request =
      // dedup by construction. Answering (any channel, incl. locally within
      // grace) drops pendingCount to 0 → onResolved clears the toast.
      {
        // Body speaks to the person AT this machine (not "answer on your
        // phone" — they're right here): the Linux toast carries an "Open
        // dashboard" button, and the dashboard is the local answer surface.
        const waiting = permissionRouter.pendingCount();
        if (desktopOn) void desktop.ping(
          `${sessionTag(key)}${title}`,
          waiting > 1 ? `${waiting} approvals waiting — click to open and answer` : 'Approval needed — click to open and answer',
        );
      }
      if (ask) {
        askFlow.begin(requestId, ask.batch, ask.input);
        askOwner.set(requestId, { key, cwd });
        askRequestIds.add(requestId); // survives the flow's consumption, so onResolved can still tell this was an ask card
      }
      // key = registry identity, cwd = real directory — carried as two
      // explicit fields all the way from requestPermission's opts (Task 5 fix
      // wave: this is exactly the upsert that used to write the key into both
      // id and cwd, permanently, when both arrived as one field).
      // An ask card ships its option payload (#50) so the dashboard renders
      // option buttons; the generic Allow/Deny path is blocked for ask
      // requestIds in onAction below (a deny would feed the agent a bogus
      // "Denied via tlive" answer to its own question — the reason ask cards
      // used to be hidden from the web entirely).
      events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key, cwd, status: 'waiting-approval', pending: {
        requestId, title, body, toolName,
        ...(ask ? { ask: askView(ask.batch, 0) } : {}),
      } }) });
    },
    onResolved: ({ key, cwd, requestId, decision, message, updatedInput }) => {
      // Warp-style lifecycle: the desktop notification exists exactly while
      // something waits. Last pending approval just resolved → close it
      // (answered means gone; the tray must never hold a stale "Waiting").
      // A permission_prompt that raced ahead of this request's registration
      // (issue #49) tracked the SAME dialog — retire it with the request so it
      // can't pin the toast; a genuine separate local prompt for another
      // session key is untouched.
      localPrompts.clear({ key });
      if (nothingWaiting()) void desktop.clear();
      askFlow.end(requestId); askOwner.delete(requestId); // no leak — covers defer/timeout/local-answer paths that skip asksubmit:/askskip: entirely
      const isAsk = askRequestIds.delete(requestId); // true only for an AskUserQuestion card (Minor 4)
      // Only touch the session view if THIS request still owns the pending slot —
      // with two concurrent approvals on one key, resolving A must not wipe B's
      // indicator (registry holds a single pending; B's card/router entry live on).
      if (sessions.get(key)?.pending?.requestId === requestId) {
        // Non-approved outcomes (deny/defer) leave the session idle; only allow → active.
        events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key, cwd, status: decision === 'allow' ? 'active' : 'idle', pending: null }) });
      }
      // Rewrite the IM cards to their outcome (buttons removed) — no zombie cards.
      const cards = sentCards.get(requestId);
      if (cards) {
        sentCards.delete(requestId);
        for (const c of cards) {
          const adapter = (opts.imAdapters ?? []).find((a) => a.channel === c.channel);
          if (!adapter) continue;
          // 结算卡保留正文 —— 回头要能看到"当时批/拒的是什么"(真机反馈:
          // 一行 `Allowed · tlive · Bash` 把命令本身丢了)。去激活靠按钮消失,
          // 不靠抹正文。
          // An ask card resolves as allow + updatedInput.answers (see
          // ask-renderer) even though the button is the wire transport — label
          // it "Answered" so the user isn't scared into thinking the pick
          // failed. The picked answer is written back onto the card (real-machine
          // feedback: after answering, "不知道当时选择的什么了"), extracted from
          // updatedInput.answers — single source of truth with buildAskUpdatedInput.
          // 带理由的拒绝(引用回复而来)vs 点按钮的光秃秃拒绝 —— 回写卡要看得出
          // 区别,所以用户知道这次拒绝是"说了理由"还是"就是不批"(Task 7)。
          const askAnswer = isAsk ? extractAskAnswer(updatedInput) : null;
          const label = askAnswer ? 'Answered'
            : decision === 'deny' && message ? 'Denied with guidance'
            : (OUTCOME[decision] ?? decision);
          const settledBody = askAnswer
            ? `${c.body}\n\n> Answered: ${askAnswer}`
            : decision === 'deny' && message && !isAsk
            ? `${c.body}\n\n> ${message.split('\n').join('\n> ')}`
            : c.body;
          // Queued (not a bare fire-and-forget edit) — this settlement edit is
          // always enqueued LAST for requestId, so it always lands last too,
          // even if an earlier toggle edit for the same rid is still in flight.
          void editQueue.enqueue(requestId, () => adapter.edit(c.messageId, { kind: 'card', title: `${label} · ${c.title}`, body: settledBody }));
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
    // A finished turn is NOT desktop-notified: it fires on every turn and
    // requires no action, so a per-turn toast just floods the screen (live
    // feedback). Completion stays on IM only — a chat log stacks fine. The
    // desktop toast is reserved for things that genuinely need you to act:
    // pending approvals (ping) and the idle "waiting for your input" nudge.
    for (const t of configuredChats()) {
      // requestId 不进显示文本:回复路由走 replyToMessageId,不解析正文。
      const raw = req.context === TURN_FINISHED_SENTINEL ? '' : req.context;
      void sendToChat(t, {
        title: 'Turn finished',
        body: buildContinueCardBody(raw),
        cwd: req.cwd,
        // No on-card input box: continuing a turn is done by quote-replying to
        // this card (inbound-handler routes a reply → the session's pending
        // continueId). The empty form + redundant Continue button read as
        // clutter; TG never rendered it anyway (quote-reply was always its path).
      });
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
      windowSec: () => approvalWindow(cfg.approvals).timeoutSec,
      log: (m) => console.log(`[codex] ${m}`),
    });
    codexResume = (threadId, input) => codexCompanion!.resume(threadId, input);
  }

  // Upstream actions from a dashboard client (/ws/events): approve/ask/reply/mute.
  const onAction = (action: import('../web/event-hub.js').EventAction): void => {
    switch (action.type) {
      case 'approve': {
        // An ask card must not be answered through generic approve/deny (#50):
        // a deny would feed the agent a bogus "Denied via tlive" answer to its
        // own question. The dashboard doesn't render Allow/Deny for ask cards;
        // this guard covers stale/hand-crafted frames.
        if (askRequestIds.has(action.requestId)) {
          console.log(`[web] generic approve on an ask card ignored: requestId=${action.requestId}`);
          return;
        }
        if (action.approved && action.alwaysAllowTool) policyState.allowTools?.add(action.alwaysAllowTool);
        const hit = permissionRouter.answer(action.requestId, action.approved);
        if (!hit) {
          // 同 IM 卡:daemon 重启后 dashboard 也可能残留旧的 pending 按钮
          // (reconcile() 通常会先一步清掉,但重连竞态下点击仍可能先到达)。
          // /ws/events 目前没有单播回发起 client 的通道(EventHub 只广播,
          // onAction 不携带发起方引用)——补这条通道是比本任务大的改动,
          // 留给后续(见 task-4 报告)。这里先落一条服务端日志,不静默吞掉。
          console.log(`[web] stale approve tapped: requestId=${action.requestId} (already resolved / daemon restarted)`);
        }
        return;
      }
      case 'ask': {
        // AskUserQuestion from the dashboard — the SAME flow the IM buttons
        // drive, so a multi-question batch advances identically whichever
        // surface you use, and the other surface repaints to match. Skip =
        // allow with NO updatedInput = pass-through, the local selector stays
        // yours — never an auto-answer, and never a half-answered batch.
        if (!askFlow.peek(action.requestId)) {
          console.log(`[web] stale ask tapped: requestId=${action.requestId} (already resolved / daemon restarted)`);
          return;
        }
        if (action.skip) {
          askFlow.end(action.requestId);
          permissionRouter.answer(action.requestId, true);
          return;
        }
        if (action.back) {
          if (askFlow.back(action.requestId).kind === 'render') repaintAsk(action.requestId);
          return;
        }
        // The dashboard sends the whole selection at once (single-pick or a
        // Submit'd checkbox set), so seed the flow's picks then submit.
        for (const i of action.picks) askFlow.toggle(action.requestId, i);
        const single = askFlow.peek(action.requestId);
        const step = single && !single.batch.questions[single.cursor].multiSelect && action.picks.length === 1 && !action.text
          ? askFlow.pick(action.requestId, action.picks[0])
          : askFlow.submit(action.requestId, action.text);
        if (step.kind === 'render') repaintAsk(action.requestId);
        else if (step.kind === 'answered') permissionRouter.answer(action.requestId, true, undefined, step.updatedInput);
        return;
      }
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
  const sockPath = daemonSocketPath(opts.home);
  /** One set of runtime toggles for every entrance — IM commands
   *  (/mute|/trust|/safe) and the CLI (`tlive mute on` … via daemon.set IPC)
   *  flip the SAME state. `enabled` = "this switch is ON": for `mute`, on = muted.
   *  `desktop` is CLI-only (`tlive desktop on|off`): the toast lives on the
   *  daemon's machine and is INDEPENDENT of `mute` (IM ⊥ desktop). */
  const runtimeSet = (key: 'mute' | 'trust' | 'safe' | 'desktop', enabled: boolean): void => {
    if (key === 'mute') muted = enabled; // /mute on ⇒ muted (quiet)
    else if (key === 'trust') policyState.trustUntilRevoked = enabled;
    // `/safe off` reverts to whatever the config asked for, not to a hard-coded
    // 'readonly' — that used to silently switch read-only auto-allow ON for a
    // user who had never opted into any auto-approval.
    else if (key === 'safe') {
      const base = cfg.approvals?.autoApprove === 'readonly' ? 'readonly' : undefined;
      policyState.autoApprove = enabled ? 'safe' : base;
    }
    else { desktopOn = enabled; if (!enabled) void desktop.clear(); }
  };

  const ipc: IpcServer = await startIpcServer({
    path: sockPath,
    handler: async (req, reply, ctx) => {
      // Identity fields only, and only the ones present on this request shape —
      // a permission request without its session/agent identity is unattributable,
      // which is what made a whole class of "why did tlive not hold this?" question
      // unanswerable from the log. Tool input is deliberately never logged.
      const idOf = (r: unknown): Record<string, unknown> => {
        const o = r as { cwd?: unknown; sessionId?: unknown; agentId?: unknown; toolName?: unknown };
        return {
          ...(typeof o.cwd === 'string' ? { cwd: o.cwd } : {}),
          ...(typeof o.sessionId === 'string' ? { sessionId: o.sessionId } : {}),
          ...(typeof o.agentId === 'string' ? { agentId: o.agentId } : {}),
          ...(typeof o.toolName === 'string' ? { toolName: o.toolName } : {}),
        };
      };
      logJson('ipc.request', { kind: req.kind, callerPid: ctx.callerPid ?? null, ...idOf(req) });
      switch (req.kind) {
        case 'daemon.status':
          reply({ kind: 'daemon.status', uptimeMs: Date.now() - startedAt, pid: process.pid, codex: codexState });
          return;
        case 'daemon.stop':
          reply({ kind: 'daemon.stopped' });
          setTimeout(() => { void shutdown(); }, 10).unref?.();
          return;
        case 'daemon.set':
          runtimeSet(req.key, req.enabled);
          reply({ kind: 'ack' });
          return;
        case 'hook.permission.request': {
          const key = resolveKey(req.sessionId, req.cwd, req.wrappedId);
          const r = await permissionRouter.requestPermission({
            key, cwd: req.cwd, toolName: req.toolName, input: req.input,
            permissionMode: req.permissionMode,
            timeoutSec: clampPermissionTimeout(req.timeoutSec),
            ...(req.sessionId ? { sessionId: req.sessionId } : {}),
            ...(req.agentId ? { agentId: req.agentId } : {}),
            ...(ctx.onDisconnect ? { onAbandoned: ctx.onDisconnect } : {}),
          });
          // 'gone' = the shim already died — the socket is gone, there is
          // nothing to reply to, and inventing a decision would itself be an
          // auto-allow path. No wire output at all.
          if (r.decision === 'gone') return;
          // 'local' (answered in the terminal) and 'handback' (you asked for the
          // dialog back) both map to 'defer' on the wire: the shim outputs
          // pass-through {} — CC then owns the prompt, which is the point.
          reply({
            kind: 'hook.permission.result',
            decision: r.decision === 'local' || r.decision === 'handback' ? 'defer' : r.decision,
            ...(r.message ? { message: r.message } : {}),
            ...(r.updatedInput !== undefined ? { updatedInput: r.updatedInput } : {}),
          });
          return;
        }
        case 'hook.permission.answer':
          permissionRouter.answer(req.requestId, req.approved, req.message);
          reply({ kind: 'ack' });
          return;
        case 'hook.continue.request': {
          const key = resolveKey(req.sessionId, req.cwd, req.wrappedId);
          // Stop = the MAIN session's turn ended; its own still-pending approval
          // card is stale. Scope to matchAgent:null — a backgrounded sub-agent
          // outlives the parent turn and its tool call is still genuinely
          // pending (and has no local answer path), so a parent Stop must NOT
          // sweep sub-agent cards; those clear via their own PostToolUse / deny.
          permissionRouter.cancel({ key, matchAgent: null });
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
          const key = resolveKey(req.sessionId, req.cwd, req.wrappedId);
          // A notify can be the FIRST thing the daemon ever hears about this
          // session (e.g. right after a daemon restart, for a session that was
          // already running) — register it before anything below renders a
          // `sessionTag(key)` label, or the very first line ever sent for this
          // session goes out with no label at all (the one thing that line
          // cannot answer on its own). The guard is an optimization, not a
          // safety belt: only a genuine miss gets this bare upsert, but an
          // existing entry would survive one anyway — `muted` is not an
          // UpsertPatch field at all, and continueId/pending/status fall back
          // to the previous value when the patch omits them.
          if (!sessions.get(key)) sessions.upsert({ key, cwd: req.cwd });
          const s = sessions.get(key);
          if (req.permissionPrompt) {
            // A CC-native permission dialog is up (issue #49). A held request
            // for this session already owns every surface (toast pinged at
            // onPending, card sent/gracing, dashboard answerable) → this
            // notification adds nothing, drop it. No held request — notify
            // mode, or the router deferred on arrival — this is the ONLY
            // signal anyone gets: run the local-waiting chain. Never carries
            // a decision; never-auto-allow untouched.
            //
            // heldOwnsIt is a PROXY and cannot be made exact: this notification
            // carries no tool_name and no agent_id (CC builds Notification input
            // without a tool-use context, so agent_id is always absent), and its
            // session_id is the main session's even when the dialog belongs to a
            // sub-agent. So "is a held card already covering this dialog?" is
            // unanswerable in principle. It is used only to avoid clobbering an
            // answerable card with the read-only one below — a wrong guess costs
            // a missed toast, never a decision.
            const heldOwnsIt = permissionRouter.hasPendingFor({ key, sessionId: req.sessionId });
            // Posture, unlike heldOwnsIt, is exact — and read LIVE (never a
            // boot-time value): the posture is remotely settable (`tlive mode`,
            // IM's `/mode`), so this must track the CURRENT rung, not whatever
            // was in config.json when the daemon started. In every holding rung
            // (`full`, `all`) every request tlive saw was either held or handed
            // back, and the one handed-back case that produces a dialog — a
            // sub-agent pass-through — already pushed a notice carrying the tool
            // and input this event lacks (see onPassthrough). So the whole chain
            // below is redundant there, and building it anyway is what produced a
            // card nothing could retire: retiring needs the answer, and the only
            // signal is the sub-agent's PostToolUse, which this path must ignore
            // because a sibling's activity must not clear the main session's
            // reminder. `notify` is the only non-holding rung reachable here
            // (`off` short-circuits in the shim before any IPC) — there this
            // chain is the ONLY signal a dialog is waiting, so it must run.
            const redundant = currentMode() !== 'notify';
            // The two arms look identical from outside — one means "tlive is
            // gating this and the card owns every surface", the other means
            // "tlive is NOT gating this, the terminal is the only answer path".
            // Confusing them is exactly how a pass-through got mistaken for a
            // held approval, so the log says which.
            logJson('permission.localPrompt', { key, ...(req.sessionId ? { sessionId: req.sessionId } : {}), heldOwnsIt, action: heldOwnsIt ? 'suppressed' : redundant ? 'holding-mode-passthrough' : 'tracked' });
            if (!heldOwnsIt && !redundant) {
              localPrompts.note(key, req.sessionId);
              // Desktop first, immediately — the waiting slot (ping/clear
              // lifecycle), not an info banner: the dialog IS a waiting state.
              if (desktopOn) void desktop.ping(`${sessionTag(key)}Permission needed`, `${req.message} — answer in the terminal`);
              // Dashboard: read-only waiting-approval card (pending.local) —
              // visible from anywhere, answerable only at the terminal.
              events.broadcast({ type: 'session-upsert', session: sessions.upsert({ key, cwd: req.cwd, status: 'waiting-approval', pending: { requestId: `local:${key}`, title: 'Permission needed', body: req.message, local: true } }) });
              // IM text rides the approval-card grace: answered at the
              // keyboard within the window → never sent (zero spam at the
              // keyboard, same contract as the held-card push). Only `notify`
              // mode reaches here, and there this text is the ONLY signal that a
              // dialog is waiting — see the posture note above.
              const pushIm = (): void => {
                // Each bail-out is logged with its own tag: "no IM text arrived"
                // has four different causes and they are not interchangeable.
                const note = (outcome: string, extra?: Record<string, unknown>): void =>
                  logJson('permission.localPrompt.im', { key, ...(req.sessionId ? { sessionId: req.sessionId } : {}), outcome, ...extra });
                if (!localPrompts.has(key, req.sessionId)) return note('answered-in-grace');
                if (permissionRouter.hasPendingFor({ key, sessionId: req.sessionId })) return note('raced-held-card');
                if (muted || sessions.get(key)?.muted) return note('muted');
                const targets = configuredChats();
                note('sent', { chatTargets: targets.length });
                for (const t of targets) void sendToChat(t, { text: `${req.message} — answer in the terminal`, cwd: key }).catch(() => undefined);
              };
              const graceSec = Math.max(cfg.approvals?.approvalGraceSec ?? 10, 0);
              if (graceSec > 0) setTimeout(pushIm, graceSec * 1000).unref();
              else pushIm();
            }
            reply({ kind: 'ack' });
            return;
          }
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
          // "等待你" FYI banner on the machine — INDEPENDENT of IM mute (IM ⊥
          // desktop): it is gated only by its own `desktopOn` switch. Info-level
          // only: the sole info-level notify CC produces (permission_prompt is
          // dropped at the shim) is "Claude is waiting for your input", exactly
          // the case a desktop poke helps. error-level (tool/stop failures) is
          // deliberately NOT banner'd — it would be noise at the keyboard; IM only.
          if (desktopOn && req.level === 'info') void desktop.info(`${sessionTag(key)}Waiting`, req.message);
          events.broadcast(applyMonitorEvent(sessions, { event: 'attention', cwd: req.cwd, sessionId: req.sessionId, message: req.message }, key));
          reply({ kind: 'ack' });
          return;
        }
        case 'hook.event': {
          const key = resolveKey(req.event.sessionId, req.event.cwd, req.wrappedId);
          const ev = req.event;
          // Local terminal answered a permission dialog → release the parallel
          // remote card (CC dual-channel: PostToolUse = approved locally,
          // PermissionDenied = denied locally, a new prompt = dialog long gone).
          // agentId — NOT sessionId — is what narrows this. CC builds every
          // hook's base input with the MAIN session id (createBaseHookInput
          // takes an explicit sessionId and the tool-event callers pass none, so
          // it falls back to the current session), and puts sub-agent identity
          // only in agent_id. So `sessionId` here is identical for the main
          // thread and every sub-agent under it and discriminates nothing;
          // matchAgent is the only field that keeps sibling sub-agents sharing
          // key+tool from cancelling each other's cards.
          if (ev.event === 'activity') {
            // 精确关联:回答者身份(agent_id 缺失 = 主会话)必须与 pending 一致
            permissionRouter.cancel({ key, toolName: ev.toolName, sessionId: ev.sessionId, matchAgent: ev.agentId ?? null });
            // This sub-agent's tool ran ⇒ its dialog was answered at the keyboard.
            // agentId is required, not optional: parallel sub-agents share key +
            // toolName, so matching without it would retire a sibling's notice.
            if (ev.agentId) retirePassthruNotice(key, ev.cwd, ev.agentId, ev.toolName);
            // Main-session tool ran → the CC-native dialog (if we tracked one)
            // was answered. Sub-agent activity doesn't touch it: a backgrounded
            // agent runs in parallel with a still-waiting main dialog. No
            // toolName narrowing — the notification never told us the tool
            // (message text only); a rare parallel-tool clear only retires the
            // reminder early, never a decision (issue #49).
            if (!ev.agentId) clearLocalPrompt(key, ev.sessionId, ev.cwd);
          } else if (ev.event === 'permission-denied') {
            permissionRouter.cancel({ key, toolName: ev.toolName, sessionId: ev.sessionId, matchAgent: null });
            clearLocalPrompt(key, ev.sessionId, ev.cwd);
          } else if (ev.event === 'prompt') {
            // 主会话新输入 → 主会话上一轮的对话框已没了,撤它的卡。matchAgent:null
            // 精确到主会话:一个 backgrounded 子 agent 的审批与父会话的输入框无关
            // (它仍真在等,且无本地答路 —— 清掉 = 保证被 deny),不得被父 prompt 清场。
            permissionRouter.cancel({ key, sessionId: ev.sessionId, matchAgent: null });
            clearLocalPrompt(key, ev.sessionId, ev.cwd);
            // 用户在键盘前开始了新一轮 → 取消上一 turn 还在 grace 里的续跑卡
            const g = continueGrace.get(key);
            if (g) { continueGrace.delete(key); g(); }
          } else if (ev.event === 'session-end') {
            // Session gone → its dialog is gone; retire the tracker so the
            // toast lifecycle can close (the registry entry is removed by
            // applyMonitorEvent below anyway).
            clearLocalPrompt(key, ev.sessionId, ev.cwd);
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
    setMuted: (m: boolean) => runtimeSet('mute', m),
    setTrust: (t: boolean) => runtimeSet('trust', t),
    getMode: () => currentMode(),
    setMode: (m) => { writeMode(opts.home, m); logJson('mode.set', { mode: m }); },
    heldSubagentCount: () => permissionRouter.heldSubagentCount(),
    setAutoApprove: (safe: boolean) => runtimeSet('safe', safe),
    addAllowTool: (tool: string) => { policyState.allowTools?.add(tool); },
    askFlow,
    repaintAsk,
    resolveReply: (channel, messageId) => msgToKey.get(`${channel}:${messageId}`),
    sessionInfo: (cwd) => {
      const s = sessions.get(cwd);
      if (!s) return undefined;
      return { kind: s.kind, label: s.label, ...(s.sockPath ? { sockPath: s.sockPath } : {}), ...(s.continueId ? { continueId: s.continueId } : {}) };
    },
    listSessions: () => sessions.list().map((s) => ({ cwd: s.cwd, kind: s.kind, label: s.label, ...(s.sockPath ? { sockPath: s.sockPath } : {}) })),
    inject: (sockPath, text) => injectInput(sockPath, text),
    findLiveCard,
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
      // Real-daemon safety net only. Under vitest (embedded bootstrapDaemon),
      // a slow teardown — e.g. the Windows runner's named-pipe ipc.close() —
      // must NOT call process.exit: it aborts the whole test process. The
      // awaited shutdown below still completes cleanly on its own.
      if (!process.env.VITEST) process.exit(0);
    }, 2000);
    forceExit.unref();
    try {
      // Answer any held IPC requests FIRST (approvals → pass-through defer,
      // continues → null) so each shim gets a clean reply and its request()
      // resolves — otherwise ipc.close() destroys the connection out from under
      // an in-flight request and it rejects (IpcConnectionClosedError). Flush a
      // tick so the replies write out before we start closing.
      permissionRouter.settleAllPending();
      continueBroker.settleAllPending();
      await new Promise((r) => setImmediate(r));
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
