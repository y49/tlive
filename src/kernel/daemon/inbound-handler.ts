// src/kernel/daemon/inbound-handler.ts
//
// v2.1: SenderGuard 鉴权 + 审批按钮回调 + /perm 静音 + 续跑自由文本。无 workspace/绑定。

import type { IncomingEnvelope, IMAdapter, IMChannel, OutgoingMessage } from '../contracts/im-adapter.js';
import type { PermissionRouter } from './permission-router.js';
import type { ContinueBroker } from '../permission/continue-broker.js';
import type { SenderGuard } from './sender-guard.js';
import type { AskSelection } from './ask-state.js';
import { parseImCommand } from './im-commands.js';
import { buildAskAnswerMessage, askMultiButtons, type AskOption } from '../permission/ask-renderer.js';
import { STALE_CARD_NOTICE } from './bootstrap.js';

export interface InboundHandlerDeps {
  senderGuard: SenderGuard;
  imBy: (channel: 'telegram' | 'feishu') => IMAdapter | undefined;
  permissionRouter: PermissionRouter;
  continueBroker: ContinueBroker;
  /** Returns + clears the most-recent pending continue requestId (single-chat). */
  takeLatestContinueId: () => string | null;
  /** Toggle global notification mute (`/perm on|off`). */
  setMuted: (muted: boolean) => void;
  /** Toggle the trust switch (auto-allow all until off). */
  setTrust: (trusted: boolean) => void;
  /** Toggle `safe` auto-approve (auto-allow non-dangerous ops; `/safe on|off`). */
  setAutoApprove: (safe: boolean) => void;
  /** Toggle desktop toasts at runtime (`/desktop on|off`) — independent of IM
   *  cards: the toast is the at-the-computer surface, the card is the phone. */
  setDesktopNotify: (enabled: boolean) => void;
  /** Grant "always allow <tool>" (in-memory). */
  addAllowTool: (tool: string) => void;
  /** Read-only lookup of the pending AskUserQuestion context for a requestId —
   *  no side effect. Used to validate an `ask:` click BEFORE consuming, so a
   *  malformed/out-of-range index doesn't eat the context out from under a
   *  legit follow-up click (review Minor 1/2). */
  peekAskContext: (requestId: string) => { question: string; options: AskOption[] } | undefined;
  /** Returns + clears the pending AskUserQuestion context for a requestId
   *  (single-use; Task 9). Populated by the permission router's onPending,
   *  consumed here once a click is validated (`ask:`/`asksubmit:`), or
   *  unconditionally on `askskip:` (discarded either way). */
  takeAskContext: (requestId: string) => { question: string; options: AskOption[] } | undefined;
  /** Multi-select checkbox state (Task 10) — per-requestId picks toggled by
   *  `asktoggle:`, read/cleared by `asksubmit:`, also freed on `askskip:` and
   *  (by the caller's onResolved) on any other resolution — never leaks past
   *  a request's pending window, same discipline as askContexts. */
  askSelection: Pick<AskSelection, 'toggle' | 'selected' | 'clear'>;
  /** The IM cards already sent for a requestId (channel + messageId), so an
   *  `asktoggle:` click can edit them in place with the refreshed checkbox
   *  state. Empty when nothing was sent yet (still in grace) or it already
   *  resolved. */
  getAskCards: (requestId: string) => Array<{ channel: string; messageId: string; title: string; body: string }>;
  /** Task 10 review Important fix: per-requestId edit serialization. edit()
   *  is a real network call — nothing guarantees a toggle edit dispatched
   *  earlier actually LANDS earlier than the settlement edit onResolved
   *  fires afterward. Every edit for a rid (toggle here, settlement in
   *  bootstrap.ts's onResolved) must go through the SAME queue instance so
   *  landing order matches enqueue order — otherwise a slow toggle edit can
   *  land after the fast settlement edit and resurrect the checkbox layout
   *  on top of the "Answered" card (a zombie-card regression). */
  queueEdit: (requestId: string, fn: () => Promise<unknown>) => Promise<void>;
  /** Reply-to routing: IM messageId → session cwd (daemon-lifetime map). */
  resolveReply: (channel: string, messageId: string) => string | undefined;
  /** Session lookup for injection routing. */
  sessionInfo: (cwd: string) => { kind: 'wrapped' | 'hook'; label: string; sockPath?: string; continueId?: string } | undefined;
  /** All current sessions (for bare-text single-session routing). */
  listSessions: () => Array<{ cwd: string; kind: 'wrapped' | 'hook'; label: string; sockPath?: string }>;
  /** Inject text into a wrapped session's pty (bracketed paste + Enter). */
  inject: (sockPath: string, text: string) => Promise<void>;
  /** IM messageId → still-live approval requestId, or null if that card has
   *  already settled (or was never a card). Backed by bootstrap.ts's sentCards,
   *  which is deleted the instant a request resolves — "findable" IS "live",
   *  same judgment-free philosophy as pending.has() (Task 7). */
  findLiveCard: (channel: string, messageId: string) => string | null;
}

function parseCallback(text: string): { requestId: string; approved: boolean } | null {
  if (text.startsWith('approve:')) return { requestId: text.slice('approve:'.length), approved: true };
  if (text.startsWith('deny:')) return { requestId: text.slice('deny:'.length), approved: false };
  return null;
}

export class InboundHandler {
  constructor(private deps: InboundHandlerDeps) {}

  async handle(env: IncomingEnvelope): Promise<void> {
    if (!this.deps.senderGuard.allows(env.channel, env.userId)) return;
    if (!env.text && !env.attachments?.length) return;

    if (env.text.startsWith('pause:')) {
      const requestId = env.text.slice('pause:'.length);
      // setTrust 是全局开关,不管这条 in-hand 请求是否还活着都要生效——只有
      // "批了这一条"这半句可能是假的,分开告知。
      this.deps.setTrust(true);
      if (this.deps.permissionRouter.answer(requestId, true)) {
        await this.reply(env, { kind: 'text', text: '已暂停审批:当前操作已放行,后续自动放行,发送 /trust off 恢复。' });
      } else {
        await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
      }
      return;
    }

    if (env.text.startsWith('allowtool:')) {
      // allowtool:<requestId>:<toolName> — grant "always allow" AND approve the in-hand request
      const rest = env.text.slice('allowtool:'.length);
      const sep = rest.indexOf(':');
      if (sep > 0) {
        const requestId = rest.slice(0, sep);
        const tool = rest.slice(sep + 1);
        // addAllowTool 同样是全局、与这条具体请求是否还活着无关——先落地。
        this.deps.addAllowTool(tool);
        if (this.deps.permissionRouter.answer(requestId, true)) {
          await this.reply(env, { kind: 'text', text: `Approved. ${tool} will be auto-allowed from now on (until daemon restart; unaffected by /trust off).` });
        } else {
          await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
        }
      }
      return;
    }

    if (env.text.startsWith('ask:')) {
      // ask:<requestId>:<optionIndex> — a picked AskUserQuestion option.
      const [, rid, idxRaw] = env.text.split(':');
      // Peek (no side effect) and validate BEFORE consuming — an out-of-range
      // or malformed index must not eat the context out from under a legit
      // follow-up click (review Minor 1). Strict digits-only match rejects ''
      // and non-numeric input; `Number('')` is 0, which would otherwise
      // silently pick option 0 (review Minor 2).
      const ctx = this.deps.peekAskContext(rid);
      if (!ctx) {
        // ctx 缺失 = 卡已 stale(daemon 重启 / 已 resolve)——告知,而非静默丢弃。
        await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
        return;
      }
      const idx = /^\d+$/.test(idxRaw) ? Number(idxRaw) : NaN;
      if (!Number.isInteger(idx) || !ctx.options[idx]) return; // 畸形 index,非 stale,维持静默
      this.deps.takeAskContext(rid); // valid pick — now consume (single-use)
      // deny + message = 答案(见 ask-renderer 文件头):CC 跳过内置问题框,
      // message 送进 agent 对话流当答案。
      if (!this.deps.permissionRouter.answer(rid, false, buildAskAnswerMessage(ctx.question, [ctx.options[idx].label]))) {
        await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
      }
      return;
    }
    if (env.text.startsWith('asktoggle:')) {
      // asktoggle:<requestId>:<optionIndex> — a multi-select checkbox flip
      // (Task 10). Same peek-then-validate discipline as `ask:`: a bad index
      // must not mutate AskSelection or touch the card. On a valid toggle,
      // edit every sent card in place so the checkboxes + Submit(N) count
      // reflect the new pick immediately.
      const [, rid, idxRaw] = env.text.split(':');
      const ctx = this.deps.peekAskContext(rid);
      const idx = /^\d+$/.test(idxRaw) ? Number(idxRaw) : NaN;
      if (!ctx || !Number.isInteger(idx) || !ctx.options[idx]) return;
      this.deps.askSelection.toggle(rid, idx);
      const buttons = askMultiButtons(rid, ctx.options, this.deps.askSelection.selected(rid));
      // Enqueue every card's edit SYNCHRONOUSLY, in this same tick — mirrors
      // bootstrap.ts's onResolved settlement loop (`void editQueue.enqueue`,
      // no per-card await). Multi-channel review Important fix: awaiting
      // each queueEdit() one at a time here left the loop suspended on a
      // slow channel's edit before it ever reached a later, faster channel's
      // card. A Submit that arrives while that await is in flight triggers
      // onResolved, whose settlement loop enqueues ALL channels' settlement
      // edits synchronously — including the fast channel this loop hadn't
      // reached yet. That settlement edit then lands first, and the toggle
      // edit (enqueued only once the slow channel's await finally resolved)
      // lands after it — resurrecting the checkbox layout on the fast
      // channel's already-"Answered" card (a zombie-card regression visible
      // only with 2+ configured channels). Firing every enqueue call before
      // yielding to the event loop guarantees this click's toggle edits are
      // all registered ahead of any settlement edit a later message could
      // trigger.
      for (const card of this.deps.getAskCards(rid)) {
        const adapter = this.deps.imBy(card.channel as IMChannel);
        if (!adapter) continue;
        void this.deps.queueEdit(rid, () => adapter.edit(card.messageId, { kind: 'card', title: card.title, body: card.body, buttons }));
      }
      return;
    }
    if (env.text.startsWith('asksubmit:')) {
      // asksubmit:<requestId> — commit the current multi-select picks (Task
      // 10). Nothing selected → no-op: a Submit tap with zero checkboxes must
      // NOT answer with an empty selection.
      const rid = env.text.slice('asksubmit:'.length);
      const ctx = this.deps.peekAskContext(rid);
      if (!ctx) {
        // ctx 缺失 = 卡已 stale ——告知,而非静默丢弃。picked.length===0(有
        // ctx 但没勾选)不是 stale,是正常"啥都没选就点提交",维持静默。
        await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
        return;
      }
      const picked = this.deps.askSelection.selected(rid);
      if (!picked.length) return;
      this.deps.takeAskContext(rid); // valid submit — now consume (single-use)
      this.deps.askSelection.clear(rid); // free the selection, no leak
      if (!this.deps.permissionRouter.answer(rid, false, buildAskAnswerMessage(ctx.question, picked.map((i) => ctx.options[i].label)))) {
        await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
      }
      return;
    }
    if (env.text.startsWith('askskip:')) {
      const rid = env.text.slice('askskip:'.length);
      // 对称性 hardening(opus 终审):与 ask:/asktoggle:/asksubmit: 一致,先
      // peek 校验(只读,不消费)context 还在才往下动。实际不可达(没有非
      // ask 卡渲染 askskip 按钮,普通卡 rid 不进文本),但纵深防御——防止
      // 未知/过期 rid 被当场 answer(rid, true) 放行。
      // 告知不冲突这条 hardening:下面这条回复只是文案,并不调用 answer(),
      // 所以"未知 rid 绝不能被当场放行"这条底线原样保留;只是不再对着一次
      // 真实无效的点击装聋作哑。
      if (!this.deps.peekAskContext(rid)) {
        await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
        return;
      }
      this.deps.takeAskContext(rid); // clear, avoid leak — the answer itself is discarded
      this.deps.askSelection.clear(rid); // free any multi-select picks too (Task 10, no leak)
      // Skip = allow = pass-through:本地问题框归你在电脑前答(等同 defer 语义),
      // 不是自动批准执行工具。
      if (!this.deps.permissionRouter.answer(rid, true)) {
        await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
      }
      return;
    }

    const cb = parseCallback(env.text);
    if (cb) {
      if (!this.deps.permissionRouter.answer(cb.requestId, cb.approved)) {
        await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
      }
      return;
    }

    const cmd = parseImCommand(env.text);
    if (cmd) {
      await this.runCommand(env, cmd);
      return;
    }

    // Native input box submits (Feishu form): text = the routing id, typed
    // content rides as formText. The remote twin of "Type something".
    if (env.formText) {
      const askIn = /^askinput:(.+)$/.exec(env.text);
      if (askIn) {
        const rid = askIn[1];
        const askCtx = this.deps.peekAskContext(rid);
        if (askCtx) {
          const picked = this.deps.askSelection.selected(rid).map((i) => askCtx.options[i]?.label).filter((l): l is string => Boolean(l));
          const answer = buildAskAnswerMessage(askCtx.question, [...picked, env.formText]);
          this.deps.takeAskContext(rid);
          if (!this.deps.permissionRouter.answer(rid, false, answer)) {
            await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
          }
        } else {
          await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
        }
        return;
      }
      const contIn = /^continueinput:(.+)$/.exec(env.text);
      if (contIn) {
        if (!this.deps.continueBroker.answer(contIn[1], env.formText)) {
          await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
        }
        return;
      }
    }

    // Reply-to routing: quoting a tlive message targets that message's session.
    if (env.replyToMessageId) {
      await this.routeReply(env);
      return;
    }

    const continueId = env.text ? this.deps.takeLatestContinueId() : null;
    if (continueId) {
      const hit = this.deps.continueBroker.answer(continueId, env.text);
      if (hit) return;
    }

    // Bare text: with exactly ONE wrapped session, inject directly; more → ask to quote.
    const wrapped = this.deps.listSessions().filter((s) => s.kind === 'wrapped' && s.sockPath);
    if (wrapped.length === 1) {
      await this.injectTo(env, wrapped[0].sockPath!, wrapped[0].label);
      return;
    }
    if (wrapped.length > 1) {
      await this.reply(env, { kind: 'text', text: `有 ${wrapped.length} 个活跃会话,请引用(回复)对应会话的消息来指定目标。` });
      return;
    }

    await this.reply(env, {
      kind: 'text',
      text: 'tlive: 无活动会话可接收文本。引用某条会话消息可将文本发入该终端(需 tlive run 包裹);命令见 /help。',
    });
  }

  /** Quoted-message routing: live approval card > live continue answer > wrapped pty injection > guidance. */
  private async routeReply(env: IncomingEnvelope): Promise<void> {
    // 引用一张仍然活跃的审批卡 = 对那次审批的答复,而不是给会话发消息。
    // 带上文字 = 带理由的拒绝:CC 会把 message 原样送进 agent 的对话流,
    // agent 据此换方案继续,而不是撞上一句干巴巴的 "Denied via tlive" 后停摆。
    // (wire 事实:只有 deny 能带话,allow 不带 message —— 引用回复因此在构造上
    // 就是 deny-only,绝不可能被这条路径用来批准任何东西。)
    const rid = env.text ? this.deps.findLiveCard(env.channel, env.replyToMessageId!) : null;
    if (rid) {
      // Quoting a live ASK card with text = the free-form answer (the remote
      // twin of the local dialog's "Type something"). Multi-select: any boxes
      // already ticked ride along with the typed text. The wire is the same
      // deny+message, but the message must be the ask three-parter — a bare
      // deny reason reads as a refusal, not an answer.
      const askCtx = this.deps.peekAskContext(rid);
      if (askCtx) {
        const picked = this.deps.askSelection.selected(rid).map((i) => askCtx.options[i]?.label).filter((l): l is string => Boolean(l));
        const answer = buildAskAnswerMessage(askCtx.question, [...picked, env.text!]);
        this.deps.takeAskContext(rid); // consume (single-use), same as a button pick
        if (!this.deps.permissionRouter.answer(rid, false, answer)) {
          await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
        }
        return;
      }
      if (!this.deps.permissionRouter.answer(rid, false, env.text)) {
        await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
      }
      return;
    }
    const cwd = this.deps.resolveReply(env.channel, env.replyToMessageId!);
    if (!cwd) {
      await this.reply(env, { kind: 'text', text: '找不到该消息对应的会话(daemon 可能重启过),请引用较新的消息。' });
      return;
    }
    const s = this.deps.sessionInfo(cwd);
    if (!s) {
      await this.reply(env, { kind: 'text', text: '该会话已结束。' });
      return;
    }
    // A pending Stop-continue is the official resume path — prefer it over injection.
    // (Attachment-only messages skip this: an empty continue reply is meaningless.)
    if (s.continueId && env.text && this.deps.continueBroker.answer(s.continueId, env.text)) return;
    if (s.kind === 'wrapped' && s.sockPath) {
      await this.injectTo(env, s.sockPath, s.label);
      return;
    }
    await this.reply(env, { kind: 'text', text: `[${s.label}] 未用 tlive run 包裹,无法注入文本。审批请用按钮;续跑请在「续跑」提示后直接回复。` });
  }

  private async injectTo(env: IncomingEnvelope, sockPath: string, label: string): Promise<void> {
    // Attachments arrive as local paths (downloaded by the adapter) — hand the
    // agent the paths alongside the caption text; it reads them itself.
    const paths = (env.attachments ?? []).map((a) => a.localPath);
    const text = [env.text, ...paths].filter(Boolean).join('\n');
    if (!text) return;
    try {
      await this.deps.inject(sockPath, text);
      const n = paths.length;
      await this.reply(env, { kind: 'text', text: `Sent to [${label}]${n ? ` (${n} attachment path${n === 1 ? '' : 's'})` : ''}` });
    } catch {
      await this.reply(env, { kind: 'text', text: `[${label}] 注入失败:会话可能已退出。` });
    }
  }

  private async runCommand(env: IncomingEnvelope, cmd: NonNullable<ReturnType<typeof parseImCommand>>): Promise<void> {
    switch (cmd.kind) {
      case 'perm':
        this.deps.setMuted(!cmd.enabled); // /perm on ⇒ notifications on ⇒ not muted
        await this.reply(env, { kind: 'text', text: `Notifications ${cmd.enabled ? 'on' : 'muted'}` });
        return;
      case 'trust':
        this.deps.setTrust(cmd.enabled);
        await this.reply(env, { kind: 'text', text: `Approvals ${cmd.enabled ? 'paused (everything auto-allowed)' : 'resumed'}` });
        return;
      case 'safe':
        this.deps.setAutoApprove(cmd.enabled);
        await this.reply(env, { kind: 'text', text: cmd.enabled
          ? 'Safe auto-approve ON — routine ops run without a card; dangerous ops, MCP/unknown tools, and questions still ask.'
          : 'Safe auto-approve OFF — back to asking for everything except read-only tools.' });
        return;
      case 'desktop':
        this.deps.setDesktopNotify(cmd.enabled);
        await this.reply(env, { kind: 'text', text: `Desktop notifications ${cmd.enabled ? 'on' : 'off'} (IM cards unaffected)` });
        return;
      case 'help':
        await this.reply(env, { kind: 'text', text: '/perm on|off — notifications on/mute\n/trust on|off — pause/resume approvals (auto-allow all)\n/safe on|off — auto-allow routine ops, still ask for dangerous/unknown ones\n/help — this help\n\nReply to a session message with text → injected into that terminal (needs a tlive run wrapper)\nWith a single active session, just send text' });
        return;
      case 'unknown':
      default:
        await this.reply(env, { kind: 'text', text: 'Unknown command — try /help.' });
    }
  }

  private async reply(env: IncomingEnvelope, msg: OutgoingMessage): Promise<void> {
    const a = this.deps.imBy(env.channel);
    if (!a) return;
    await a.send(msg);
  }
}
