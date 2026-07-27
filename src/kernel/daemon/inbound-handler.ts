// src/kernel/daemon/inbound-handler.ts
//
// v2.1: SenderGuard 鉴权 + 审批按钮回调 + /mute 静音(仅 IM)+ 续跑自由文本。无 workspace/绑定。

import type { IncomingEnvelope, IMAdapter, IMChannel, OutgoingMessage } from '../contracts/im-adapter.js';
import type { PermissionRouter } from './permission-router.js';
import type { ContinueBroker } from '../permission/continue-broker.js';
import type { SenderGuard } from './sender-guard.js';
import type { AskFlow, AskStep } from './ask-flow.js';
import { parseImCommand } from './im-commands.js';
import { STALE_CARD_NOTICE } from './bootstrap.js';

export interface InboundHandlerDeps {
  senderGuard: SenderGuard;
  imBy: (channel: 'telegram' | 'feishu') => IMAdapter | undefined;
  permissionRouter: PermissionRouter;
  continueBroker: ContinueBroker;
  /** Returns + clears the most-recent pending continue requestId (single-chat). */
  takeLatestContinueId: () => string | null;
  /** Toggle IM notification mute (`/mute on|off`; on = muted). IM only —
   *  desktop toasts have their own switch. */
  setMuted: (muted: boolean) => void;
  /** Toggle the trust switch (auto-allow all until off). */
  setTrust: (trusted: boolean) => void;
  /** Toggle `safe` auto-approve (auto-allow non-dangerous ops; `/safe on|off`). */
  setAutoApprove: (safe: boolean) => void;
  /** Grant "always allow <tool>" (in-memory). */
  addAllowTool: (tool: string) => void;
  /** AskUserQuestion progress for every pending request: the parsed batch, the
   *  cursor, the answers collected so far and the current question's checkbox
   *  picks. Started by the permission router's onPending, consumed the moment
   *  the last question is answered, freed on skip / any other resolution.
   *  Validation lives inside it, so a malformed click returns `noop` without
   *  eating the context out from under a legit follow-up (review Minor 1/2). */
  askFlow: Pick<AskFlow, 'peek' | 'pick' | 'toggle' | 'submit' | 'back' | 'end'>;
  /** Repaint every surface for this request at the flow's current cursor — the
   *  IM cards already sent AND the dashboard session card. Owned by bootstrap
   *  because both surfaces must move together: the daemon holds the cursor, so
   *  answering a question here has to advance the dashboard too. */
  repaintAsk: (requestId: string) => void;
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

/** `set:<which>:<on|off>` — the button click emitted by a toggle-prompt card
 *  (a bare /mute /trust /safe tap). Explicit on/off, so a menu tap never blindly
 *  flips a dangerous state. */
function parseSetCallback(text: string): { which: 'mute' | 'trust' | 'safe'; on: boolean } | null {
  if (!text.startsWith('set:')) return null;
  const [, which, state] = text.split(':');
  if ((which === 'mute' || which === 'trust' || which === 'safe') && (state === 'on' || state === 'off')) {
    return { which, on: state === 'on' };
  }
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
      // ask:<requestId>:<optionIndex> — a picked single-select option. Strict
      // digits-only match rejects '' and non-numeric input; `Number('')` is 0,
      // which would otherwise silently pick option 0 (review Minor 2).
      const [, rid, idxRaw] = env.text.split(':');
      const idx = /^\d+$/.test(idxRaw) ? Number(idxRaw) : NaN;
      await this.applyAskStep(env, rid, Number.isInteger(idx) ? this.deps.askFlow.pick(rid, idx) : { kind: 'noop' });
      return;
    }
    if (env.text.startsWith('asktoggle:')) {
      // asktoggle:<requestId>:<optionIndex> — a multi-select checkbox flip.
      // Validation lives in the flow: a bad index returns noop without
      // touching state or the card.
      const [, rid, idxRaw] = env.text.split(':');
      const idx = /^\d+$/.test(idxRaw) ? Number(idxRaw) : NaN;
      await this.applyAskStep(env, rid, Number.isInteger(idx) ? this.deps.askFlow.toggle(rid, idx) : { kind: 'noop' });
      return;
    }
    if (env.text.startsWith('asksubmit:')) {
      // asksubmit:<requestId> — commit the current question's picks. Feishu's
      // form submit rides its input-box text along as formText; ticks and text
      // merge into one answer. Both empty = no-op (an empty answer is not an
      // answer), enforced inside the flow.
      const rid = env.text.slice('asksubmit:'.length);
      await this.applyAskStep(env, rid, this.deps.askFlow.submit(rid, env.formText));
      return;
    }
    if (env.text.startsWith('askback:')) {
      // askback:<requestId> — step back one question in a multi-question
      // batch, dropping that answer so it gets asked again. Rescues a misclick
      // on a single-select question, which otherwise advances on one tap.
      const rid = env.text.slice('askback:'.length);
      await this.applyAskStep(env, rid, this.deps.askFlow.back(rid));
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
      if (!this.deps.askFlow.peek(rid)) {
        await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
        return;
      }
      // 整批作废,连同已答的前几问 —— Skip 绝不提交半份答案。
      this.deps.askFlow.end(rid);
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

    // Toggle-prompt button click (from a bare /mute /trust /safe menu tap) —
    // route to the exact same setter + confirmation as the typed `<cmd> on|off`.
    const set = parseSetCallback(env.text);
    if (set) {
      const cmd = set.which === 'mute' ? { kind: 'mute' as const, muted: set.on }
        : set.which === 'trust' ? { kind: 'trust' as const, enabled: set.on }
        : { kind: 'safe' as const, enabled: set.on };
      await this.runCommand(env, cmd);
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
        await this.applyAskStep(env, rid, this.deps.askFlow.submit(rid, env.formText));
        return;
      }
      // (The continuation card has no on-card input box; continuing is done by
      // quote-replying to the card — see routeReply below.)
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
      // already ticked ride along with the typed text. Answered via allow +
      // updatedInput.answers (same as a button pick) so CC treats it as the
      // question's answer, not a refusal.
      if (this.deps.askFlow.peek(rid)) {
        await this.applyAskStep(env, rid, this.deps.askFlow.submit(rid, env.text!));
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

  /** Single landing point for every AskUserQuestion interaction — button pick,
   *  checkbox toggle, Submit, Back, Feishu form text, quote-reply text. The
   *  flow decides what happened; this only carries it out. Before this, five
   *  call sites each re-implemented "look up context → assemble answer →
   *  answer()", which is how multi-question support could be missing from all
   *  of them at once. */
  private async applyAskStep(env: IncomingEnvelope, requestId: string, step: AskStep): Promise<void> {
    switch (step.kind) {
      case 'stale':
        // ctx 缺失 = 卡已 stale(daemon 重启 / 已 resolve)——告知,而非静默丢弃。
        await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
        return;
      case 'noop':
        // 畸形下标 / 空提交:不是 stale,是一次无效点击,维持静默。
        return;
      case 'render':
        this.deps.repaintAsk(requestId);
        return;
      case 'answered':
        // allow + updatedInput.answers = 答案(见 ask-renderer 文件头):CC 把
        // AskUserQuestion 当"已回答"正常跑,自己生成干净反馈,无 Error 外壳。
        if (!this.deps.permissionRouter.answer(requestId, true, undefined, step.updatedInput)) {
          await this.reply(env, { kind: 'text', text: STALE_CARD_NOTICE });
        }
        return;
    }
  }

  private async runCommand(env: IncomingEnvelope, cmd: NonNullable<ReturnType<typeof parseImCommand>>): Promise<void> {
    switch (cmd.kind) {
      case 'mute':
        this.deps.setMuted(cmd.muted); // /mute on ⇒ muted (quiet); /mute off ⇒ notifications on
        await this.reply(env, { kind: 'text', text: `IM notifications ${cmd.muted ? 'muted' : 'on'}${cmd.muted ? ' (desktop toasts unaffected — toggle at the machine with `tlive desktop`)' : ''}` });
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
      case 'toggle-prompt': {
        // Bare /mute /trust /safe (a menu tap sends the command with no arg). Reply
        // with explicit on/off buttons instead of "Unknown command" — the tap is now
        // actionable, and staying explicit (vs a blind flip) means a menu tap can
        // never one-shot enable a dangerous state like /trust.
        const P = {
          mute: { title: 'tlive · /mute', body: 'Mute IM notifications? (on = quiet; desktop toasts are separate)', on: 'Mute (quiet)', off: 'Notifications on' },
          trust: { title: 'tlive · /trust', body: 'Pause approvals? “On” auto-allows **everything** until you resume.', on: 'Pause (auto-allow all)', off: 'Resume' },
          safe: { title: 'tlive · /safe', body: 'Safe auto-approve? Routine ops run without a card; dangerous / MCP / unknown tools still ask.', on: 'Safe on', off: 'Safe off' },
        }[cmd.which];
        await this.reply(env, {
          kind: 'card', title: P.title, body: P.body,
          buttons: [{ id: `set:${cmd.which}:on`, label: P.on }, { id: `set:${cmd.which}:off`, label: P.off }],
        });
        return;
      }
      case 'help':
        // A card (not bare text): commands as inline-code chips, the reply hint
        // as its own paragraph — so it renders with structure on both channels
        // (grey header = informational; live feedback: plain text "没有样式").
        await this.reply(env, {
          kind: 'card',
          title: 'tlive · commands',
          body: [
            '`/mute on|off` — mute / unmute IM notifications (on = quiet)',
            '`/trust on|off` — pause / resume approvals (auto-allow all)',
            '`/safe on|off` — auto-allow routine ops, still ask for dangerous / unknown',
            '`/help` — this help',
            '',
            '**Reply to a session** — quote-reply its message and your text is injected into that terminal (needs a `tlive run` wrapper). With a single active session, just send text.',
            '',
            'IM and desktop are separate: `/mute` only silences IM. Desktop toasts have their own machine-local switch, `tlive desktop on|off` (not an IM command).',
          ].join('\n'),
        });
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
