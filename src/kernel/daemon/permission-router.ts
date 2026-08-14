// src/kernel/daemon/permission-router.ts
import { randomUUID } from 'node:crypto';
import type { AskBatch } from '../permission/ask-renderer.js';

/** Everything an AskUserQuestion card needs, carried as one unit: the whole
 *  parsed batch (a call can hold several questions) plus the raw tool input,
 *  which the answer is built by spreading. */
export interface AskContext { batch: AskBatch; input: unknown }

/** 'local' = 用户在本地终端答的;IPC 层映射成 'defer'(shim 输出 pass-through {})—— 绝不 auto-allow。
 *  'handback' = 用户在卡上点了 "Answer at the terminal instead":同样映射成
 *           'defer',让 CC 当场把框建到终端里。与 'defer' 分开只为一件事——
 *           卡不能撒谎:超时是 "Timed out",这个是 "Handed back to the terminal"。
 *  'gone'  = 调用方(shim)在等待中异常死亡(会话被 Ctrl+C / 终端关闭)。终态,
 *           **不产生任何 wire 输出**(shim 已死,本就送不出去),仅用于把卡
 *           改写成 "Session ended" —— 卡必须说真话。 */
export type Decision = 'allow' | 'deny' | 'defer' | 'local' | 'gone' | 'handback';
export interface PermChat { channel: string; chatId: string }

export interface PermissionRouterDeps {
  configuredChats: () => PermChat[];
  /** `ask` (present only for an AskUserQuestion card) drives the remote
   *  card's option buttons instead of the usual Allow/Deny. multiSelect
   *  (Task 10) additionally selects the checkbox/Submit(N)/Skip layout over
   *  the single-pick numbered buttons — both are opaque booleans/arrays to
   *  this vendor-neutral layer, it never inspects toolName itself. */
  sendToChat: (target: PermChat, card: { title: string; body: string; requestId: string; toolName: string; cwd: string; ask?: AskContext; agentId?: string }) => Promise<void>;
  /** `key` — the session's registry identity (see requestPermission's `key` opt), NOT the real cwd.
   *  Mutes the IM card ONLY (desktop toast / dashboard stay live) — it no longer
   *  defers the whole approval on its own (see requestPermission). */
  isMuted: (key: string) => boolean;
  /** True when at least one dashboard client is connected on /ws/events —
   *  a card can be answered from the web even with zero IM chats. */
  hasWebClients: () => boolean;
  /** True when a dashboard exists to answer a card from, without IM. Lets a
   *  muted-IM approval still be answered locally instead of deferring to the
   *  terminal. */
  hasLocalAnswerPath: () => boolean;
  /** Vendor-neutral policy: allow (auto) vs ask (send card). Never auto-denies. */
  policyDecide: (req: { toolName: string; input: unknown; permissionMode?: string }) => { decision: 'allow' | 'ask'; reason?: string };
  /** Render the approval card body from the normalized request. `ask` is the
   *  AskUserQuestion branch's extra — absent for every other tool. It carries
   *  the WHOLE parsed batch plus the raw tool input, because a batch can hold
   *  several questions and the answer must be built by spreading the original
   *  input (see ask-renderer); passing a flattened single question here is
   *  what silently dropped questions 2..N. */
  renderCard: (req: { toolName: string; input: unknown }) => { title: string; body: string; ask?: AskContext };
  /** Fired when a card is created & sent (session enters waiting-approval).
   *  `key` and `cwd` are carried as two separate, explicit fields — never
   *  collapse them back into one. `key` is the session's registry identity
   *  (matches requestPermission's `key` opt); `cwd` is the real working
   *  directory, threaded through only for the registry's display field
   *  (label = basename(cwd)). Conflating them here is exactly the bug this
   *  split fixes (see resolveKey in bootstrap.ts). */
  onPending?: (p: { key: string; cwd: string; requestId: string; title: string; body: string; toolName: string; input: unknown; ask?: AskContext }) => void;
  /** Fired when a request is handed straight back to the vendor instead of being
   *  held — today only the sub-agent pass-through. The point is that tlive is
   *  holding the whole request at that instant (tool, input, agentId) while the
   *  only other signal the user would get, CC's permission_prompt notification,
   *  carries neither tool name nor agentId and so can say nothing useful. Without
   *  this the blocked sub-agent is invisible.
   *
   *  Informational only: the dialog it refers to can be answered at the keyboard
   *  and nowhere else, because CC awaits the hook before building the dialog, so
   *  by the time it exists this hook invocation is over. Consumers must not offer
   *  an Allow/Deny affordance for it. `agentId` + `toolName` are carried because
   *  together they are the one pair that also comes back on the sub-agent's
   *  PostToolUse, which is how the notice gets retired.
   *
   *  `input` is the raw tool input, carried so a consumer can summarize the
   *  call itself rather than parse the rendered card back apart. */
  onPassthrough?: (p: { key: string; cwd: string; agentId: string; toolName: string; title: string; body: string; input: unknown }) => void;
  /** Fired when the request resolves (answered / timed out / deferred after a card). Same key/cwd split as onPending.
   *  message:带理由的拒绝所携带的文本(引用回复而来)—— 供回写区分
   *  `Denied` 与 `Denied with guidance`。
   *  updatedInput:AskUserQuestion 的答案(allow + updatedInput.answers,见
   *  ask-renderer)—— 供结算卡回写"Answered: …"。 */
  onResolved?: (p: { key: string; cwd: string; requestId: string; decision: Decision; message?: string; updatedInput?: unknown }) => void;
  /** 发 IM 卡前的静默期(秒)。本地秒答的审批在此窗口内 cancel → 卡永不发出
   *  (键盘前零刷屏)。0 = 立即发。web 广播(onPending)不受影响。 */
  graceSec: () => number;
  /** 子 agent(请求带 agentId)的审批是否也 hold 等远程答。默认(缺省/false)=
   *  pass-through:立即 defer(→ shim 输出 {} → CC 原生处理:交互终端弹本地框、
   *  无头 auto-deny)。理由:被后台化的子 agent 在同步 hook 被 hold 期间**没有**
   *  并行本地框(只有主会话有,先答先得 —— 真机实测),所以 hold 一个子 agent 会
   *  引入一个 CC 自己根本不会有的阻塞,且超时前没有本地兜底。tlive 因此默认对
   *  子 agent 完全透明;想手机远程批子 agent 的人切到顶档 posture(`mode: all`,
   *  见 src/kernel/config/mode.ts)opt-in 打开。
   *
   *  机制(从 CC 二进制读出,2.1.216–2.1.220 一致):CC 给"能弹框的异步 agent"
   *  的权限上下文置 `awaitAutomatedChecksBeforeDialog`,于是它**先 await 完
   *  PermissionRequest hook 再决定要不要建框** —— hook 给了决定,框就永不渲染。
   *  主会话不设这个 flag:hook 跑在与框并行的后台任务里,由一个 claim 闩锁先答
   *  先得,所以主会话 hold 住不会失去终端。又:自 CC 2.1.198 起子代理默认后台
   *  运行(`status: "async_launched"`),所以这条几乎覆盖所有子代理。 */
  holdSubagents?: () => boolean;
  /** 超时动作(opt-in)。默认(缺省/`'defer'`)= 超时落回 `{}`(CC 原生:本地框
   *  继续等 / 无头 auto-deny),绝不自动决定。`'deny'` = 超时即拒(带"timed out"
   *  说明),让 turn 得以结束 → 续跑卡可重定向。deny 是安全方向,不破 never-auto-
   *  allow 地板。只作用于**真的 hold 到超时**的请求,不影响答复面缺失的即时 defer。 */
  timeoutAction?: () => 'defer' | 'deny';
  /** Diagnostics. Called once per outcome of requestPermission with a stable
   *  `reason` tag, and once again when a held request resolves. Identity fields
   *  only — never the tool input, which can carry secrets.
   *
   *  This exists because "why didn't tlive hold this one?" was unanswerable from
   *  the outside: five separate paths return without a card (policy allow,
   *  sub-agent pass-through, no answer surface, timeout, caller gone) and they
   *  are indistinguishable in the log, which turned one regression into several
   *  rounds of guesswork. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** 超时改判为 deny 时给 agent 的说明——让它知道不是硬拒、是没人及时答,可重试。 */
const TIMEOUT_DENY_MESSAGE = 'Approval timed out — no one answered within the window, so the tool was not run. Ask again if it is still needed.';

/** Unanswered request auto-defers after this (s). Must be < shim IPC (590s) < hook timeout (600s). */
const PERMISSION_TIMEOUT_SEC = 580;

interface PendingEntry {
  resolve: (d: { decision: Decision; message?: string; updatedInput?: unknown }) => void;
  key: string;
  toolName: string;
  sessionId?: string;
  agentId?: string;
}

/** 关联字段匹配:双方都带且非空才比较;任一侧缺失 = 通配(保守,宁可多释放
 *  一张卡——释放只是 {} pass-through,绝不 auto-allow)。 */
function fieldMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true;
  return a === b;
}

export class PermissionRouter {
  private pending = new Map<string, PendingEntry>();
  /** requestId → which surface settled it, read once by requestPermission when
   *  its await returns. Set by whoever resolves; absent means nothing claimed it. */
  private resolvedBy = new Map<string, string>();
  constructor(private deps: PermissionRouterDeps) {}

  /** `key` is the session's registry identity — used for pending-map matching
   *  (cancel/mute/card-routing) exactly like `cancel()`'s `key` opt. `cwd` is
   *  the real working directory; this layer never matches on it, it is only
   *  threaded through to onPending/onResolved so the registry can display the
   *  real directory without the router having to know what a registry is.
   *  Keeping them as two required, separate fields is the whole point of this
   *  split — collapsing them back into one is the bug (see bootstrap.ts's
   *  resolveKey doc comment). */
  async requestPermission(opts: { key: string; cwd: string; toolName: string; input: unknown; permissionMode?: string; timeoutSec?: number; sessionId?: string; agentId?: string; onAbandoned?: (cb: () => void) => void }): Promise<{ decision: Decision; message?: string; updatedInput?: unknown }> {
    // Identity only — the tool input can carry secrets and never goes to the log.
    const who = {
      key: opts.key,
      toolName: opts.toolName,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    };
    const outcome = (reason: string, extra?: Record<string, unknown>): void =>
      this.deps.log?.('permission.outcome', { ...who, reason, ...extra });

    // Policy first: an auto-allow (read-only / trust switch) skips the card even when muted.
    const pd = this.deps.policyDecide({ toolName: opts.toolName, input: opts.input, permissionMode: opts.permissionMode });
    if (pd.decision === 'allow') {
      outcome('policy-allow', { ...(pd.reason ? { policyReason: pd.reason } : {}) });
      return { decision: 'allow' };
    }

    // Sub-agent pass-through (方案①): stay transparent for backgrounded/async
    // sub-agents by default (see holdSubagents doc). Holding one blocks it with no
    // parallel local dialog until the window times out — a block CC never has on its
    // own. defer → shim {} → CC-native (local dialog if interactive, else auto-deny).
    // Runs AFTER the policy allow-check, so a safe/trusted sub-agent tool still
    // auto-allows; the top posture rung (`mode: all`) makes sub-agent approvals
    // remotely answerable instead.
    if (opts.agentId && !(this.deps.holdSubagents?.() ?? false)) {
      outcome('subagent-passthrough');
      // Handed back — but say what was handed back, while we still hold the
      // details. See onPassthrough for why this is the only chance to.
      if (this.deps.onPassthrough) {
        const { title, body } = this.deps.renderCard({ toolName: opts.toolName, input: opts.input });
        this.deps.onPassthrough({ key: opts.key, cwd: opts.cwd, agentId: opts.agentId, toolName: opts.toolName, title, body, input: opts.input });
      }
      return { decision: 'defer' };
    }

    // Answer-surface gate: fall back to the local terminal (defer) only when
    // NOBODY can answer remotely. Muting IM (/mute) no longer defers on its own
    // — it just silences the IM card (see push() below); any live dashboard
    // client remains an independent answer path (the desktop toast is only a
    // pointer to it, never an answer surface itself).
    const targets = this.deps.configuredChats();
    const imUsable = targets.length > 0 && !this.deps.isMuted(opts.key);
    const webUsable = this.deps.hasWebClients();
    const localUsable = this.deps.hasLocalAnswerPath();
    if (!imUsable && !webUsable && !localUsable) {
      // Each input is recorded, not just the verdict: "no answer surface" says
      // nothing about WHICH surface was missing, and that is the whole question.
      outcome('no-answer-surface', { chatTargets: targets.length, muted: this.deps.isMuted(opts.key), webUsable, localUsable });
      return { decision: 'defer' };
    }

    const requestId = randomUUID();
    const { title, body, ask } = this.deps.renderCard({ toolName: opts.toolName, input: opts.input });
    const result = await new Promise<{ decision: Decision; message?: string; updatedInput?: unknown }>((resolve) => {
      this.pending.set(requestId, {
        resolve,
        key: opts.key,
        toolName: opts.toolName,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
      });
      outcome('held', { requestId, chatTargets: targets.length, webUsable, localUsable, graceSec: this.deps.graceSec(), windowSec: opts.timeoutSec ?? PERMISSION_TIMEOUT_SEC });
      setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          this.resolvedBy.set(requestId, 'timeout');
          // Held-then-timed-out: 'deny' (opt-in) ends it so the turn can move on
          // and the continue card can redirect; 'defer' (default) falls back to
          // CC-native (local dialog / auto-deny), never auto-deciding.
          resolve(this.deps.timeoutAction?.() === 'deny'
            ? { decision: 'deny', message: TIMEOUT_DENY_MESSAGE }
            : { decision: 'defer' });
        }
      }, (opts.timeoutSec ?? PERMISSION_TIMEOUT_SEC) * 1000).unref();
      // 调用方死亡 → 放弃该 pending。判据零误判:answer()/cancel() 都先
      // pending.delete() 再 resolve,所以此时 has() 为真 ⟺ 真的没人答过。
      opts.onAbandoned?.(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          this.resolvedBy.set(requestId, 'caller-gone');
          resolve({ decision: 'gone' });
        }
      });
      // web 立即 —— dashboard 是 pull 视图,不该等 grace。
      this.deps.onPending?.({
        key: opts.key, cwd: opts.cwd, requestId, title, body, toolName: opts.toolName, input: opts.input,
        ...(ask ? { ask } : {}),
      });
      // IM 卡走 grace:开火时 pending 还在才发。cancel()/answer() 都先 delete
      // 再 resolve,所以这一句就是权威判据,不需要额外的取消令牌。
      const push = (): void => {
        if (!this.pending.has(requestId)) return;
        if (this.deps.isMuted(opts.key)) return; // grace 期间 mute 了 → 尊重
        for (const t of targets) {
          // card.cwd carries `key` (not the real directory) — the label tag
          // lookup and reply-routing map (bootstrap.ts's sessionTag/rememberMsg)
          // both index by registry key, same convention as hook.notify/
          // hook.continue.request elsewhere in bootstrap.ts.
          // A failed send used to be swallowed outright. It must be logged: the
          // request stays held with one fewer answer surface than the `held` line
          // above advertised, and without this line the single most likely cause
          // of "the card never arrived" leaves no trace anywhere — which is
          // exactly how an oversized Telegram callback_data (see toolNameFor)
          // went unnoticed. Still non-fatal: the local dialog is unaffected and
          // the other targets/dashboard may well have gone out.
          void this.deps.sendToChat(t, { title, body, requestId, toolName: opts.toolName, cwd: opts.key, ...(ask ? { ask } : {}), ...(opts.agentId ? { agentId: opts.agentId } : {}) })
            .catch((e: unknown) => {
              this.deps.log?.('permission.card.undelivered', {
                ...who, requestId, channel: t.channel, error: e instanceof Error ? e.message : String(e),
              });
            });
        }
      };
      const grace = this.deps.graceSec();
      if (grace > 0) setTimeout(push, grace * 1000).unref();
      else push();
    });
    // `by` is the answer surface that won the race — the single most useful field
    // when the question is "did the terminal or the phone settle this one".
    const by = this.resolvedBy.get(requestId) ?? 'unknown';
    this.resolvedBy.delete(requestId);
    this.deps.log?.('permission.resolved', { ...who, requestId, decision: result.decision, by });
    this.deps.onResolved?.({ key: opts.key, cwd: opts.cwd, requestId, decision: result.decision, ...(result.message ? { message: result.message } : {}), ...(result.updatedInput !== undefined ? { updatedInput: result.updatedInput } : {}) });
    return result;
  }

  /** Approvals currently waiting for an answer (desktop notification count). */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Held requests carrying an agentId — i.e. sub-agent requests currently held
   *  under the `all` posture. Used to gate the "dropping out of `all` leaves
   *  already-held sub-agent requests stranded" IM notice: `all` is the only
   *  rung that holds sub-agent requests at all, so a lower rung can only ever
   *  strand ones that were held before the switch. A held main-session request
   *  (no agentId) is never counted — it always has a parallel local dialog, so
   *  a posture drop never strands it. */
  heldSubagentCount(): number {
    let n = 0;
    for (const e of this.pending.values()) if (e.agentId) n++;
    return n;
  }

  /** Tool name of a still-pending request, for the "Always allow <tool>" button.
   *  That button cannot carry the name in its own payload: Telegram caps
   *  callback_data at 64 bytes and rejects the WHOLE message if any button is
   *  over, which `allowtool:<uuid>:<toolName>` is for every name longer than 17
   *  characters — i.e. every `mcp__<server>__<tool>`. The requestId identifies
   *  the request anyway, so the name is looked up here instead. Undefined once
   *  the request has been answered or abandoned; callers must read it BEFORE
   *  answer(), which drops the entry. */
  toolNameFor(requestId: string): string | undefined {
    return this.pending.get(requestId)?.toolName;
  }

  /** True when a held request exists for this session — the daemon's dedupe
   *  test for an incoming Notification(permission_prompt): a held card already
   *  owns every answer surface, so the notification adds nothing (issue #49).
   *  sessionId matching is the same conservative wildcard as cancel()'s.
   *
   *  Deliberately session-wide, with no agentId parameter: the caller's event
   *  (permission_prompt) has no agent_id to pass, and CC reports the main
   *  session's id for sub-agent hooks too, so nothing finer is knowable. Read
   *  this as "some card is live under this key", not "the card for THAT dialog".
   *  Callers must therefore only use it where a wrong answer is cosmetic. */
  hasPendingFor(opts: { key: string; sessionId?: string }): boolean {
    for (const e of this.pending.values()) {
      if (e.key !== opts.key) continue;
      if (!fieldMatches(e.sessionId, opts.sessionId)) continue;
      return true;
    }
    return false;
  }

  /** Graceful shutdown: resolve every held request as pass-through `defer`
   *  (CC-native fallback, the safe direction — never auto-decides). The caller
   *  (shim) then gets a clean reply and resolves normally, instead of its
   *  connection being abruptly destroyed and rejecting. Call BEFORE ipc.close()
   *  and let the replies flush. */
  settleAllPending(): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      this.resolvedBy.set(id, 'daemon-shutdown');
      entry.resolve({ decision: 'defer' });
    }
  }

  /** 返回 true = 命中并已 resolve;false = 无此 pending(卡已 stale:daemon
   *  重启 / 已超时 / 会话已结束)。调用方据此告知用户,而非静默丢弃。
   *  updatedInput:AskUserQuestion 作答走 approved=true(allow)+ updatedInput
   *  (echo questions + answers),CC 据此把工具当"已回答"正常跑,自己生成干净
   *  反馈 —— 不再是 deny+message 的 Error 外壳(见 ask-renderer)。 */
  answer(requestId: string, approved: boolean, message?: string, updatedInput?: unknown): boolean {
    const e = this.pending.get(requestId);
    if (!e) return false;
    this.pending.delete(requestId);
    this.resolvedBy.set(requestId, 'remote');
    e.resolve({ decision: approved ? 'allow' : 'deny', ...(message ? { message } : {}), ...(updatedInput !== undefined ? { updatedInput } : {}) });
    return true;
  }

  /** "Answer at the terminal instead" — hand ONE held request back to CC now
   *  instead of waiting out the window. The shim then writes {} and CC builds
   *  the dialog in the terminal (实测:defer 之后框立刻出现). Returns false when
   *  the card is already stale, so the caller can say so rather than going quiet.
   *  Never auto-allows: handing back is a pass-through, not a decision. */
  handBack(requestId: string): boolean {
    const e = this.pending.get(requestId);
    if (!e) return false;
    this.pending.delete(requestId);
    this.resolvedBy.set(requestId, 'handed-back');
    e.resolve({ decision: 'handback' });
    return true;
  }

  /** The user answered in the local terminal (PostToolUse / PermissionDenied /
   *  UserPromptSubmit / Stop observed) — release matching pending shims.
   *  `toolName` omitted = every pending request for the key.
   *  sessionId:双方都带才比较,缺失 = 通配。
   *  matchAgent 三态:undefined = 任意 agent(prompt/stop 清场);null = 仅主
   *  会话的卡(回答者是主会话,不得误放子 agent 的同 tool 卡);字符串 = 仅该
   *  agent 的卡。Never auto-allows —— 释放只是 {} pass-through。 */
  cancel(opts: { key: string; toolName?: string; sessionId?: string; matchAgent?: string | null }): number {
    let n = 0;
    for (const [rid, e] of [...this.pending]) {
      if (e.key !== opts.key) continue;
      if (opts.toolName !== undefined && e.toolName !== opts.toolName) continue;
      if (!fieldMatches(e.sessionId, opts.sessionId)) continue;
      if (opts.matchAgent !== undefined && e.agentId !== (opts.matchAgent ?? undefined)) continue;
      this.pending.delete(rid);
      this.resolvedBy.set(rid, 'local-terminal');
      e.resolve({ decision: 'local' }); // onResolved fires from requestPermission's own path
      n++;
    }
    return n;
  }
}
