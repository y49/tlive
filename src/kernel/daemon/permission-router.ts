// src/kernel/daemon/permission-router.ts
import { randomUUID } from 'node:crypto';
import type { AskOption } from '../permission/ask-renderer.js';

/** 'local' = 用户在本地终端答的;IPC 层映射成 'defer'(shim 输出 pass-through {})—— 绝不 auto-allow。
 *  'gone'  = 调用方(shim)在等待中异常死亡(会话被 Ctrl+C / 终端关闭)。终态,
 *           **不产生任何 wire 输出**(shim 已死,本就送不出去),仅用于把卡
 *           改写成 "Session ended" —— 卡必须说真话。 */
export type Decision = 'allow' | 'deny' | 'defer' | 'local' | 'gone';
export interface PermChat { channel: string; chatId: string }

export interface PermissionRouterDeps {
  configuredChats: () => PermChat[];
  /** askOptions (present only for an AskUserQuestion card) drives the remote
   *  card's option buttons instead of the usual Allow/Deny (Task 9). askMulti
   *  (Task 10) additionally selects the checkbox/Submit(N)/Skip layout over
   *  the single-pick numbered buttons — both are opaque booleans/arrays to
   *  this vendor-neutral layer, it never inspects toolName itself. */
  sendToChat: (target: PermChat, card: { title: string; body: string; requestId: string; toolName: string; cwd: string; askOptions?: AskOption[]; askMulti?: boolean }) => Promise<void>;
  /** `key` — the session's registry identity (see requestPermission's `key` opt), NOT the real cwd.
   *  Mutes the IM card ONLY (desktop toast / dashboard stay live) — it no longer
   *  defers the whole approval on its own (see requestPermission). */
  isMuted: (key: string) => boolean;
  /** True when at least one dashboard client is connected on /ws/events —
   *  a card can be answered from the web even with zero IM chats. */
  hasWebClients: () => boolean;
  /** True when the daemon's own machine can surface + answer a card without IM —
   *  i.e. the desktop toast is on AND can open a dashboard. Lets a muted-IM
   *  approval still be answered locally instead of deferring to the terminal. */
  hasLocalAnswerPath: () => boolean;
  /** Vendor-neutral policy: allow (auto) vs ask (send card). Never auto-denies. */
  policyDecide: (req: { toolName: string; input: unknown; permissionMode?: string }) => { decision: 'allow' | 'ask'; reason?: string };
  /** Render the approval card body from the normalized request. askOptions/
   *  askQuestion/askMulti are the AskUserQuestion branch's extras (Task 9/10):
   *  absent for every other tool. */
  renderCard: (req: { toolName: string; input: unknown }) => { title: string; body: string; askOptions?: AskOption[]; askQuestion?: string; askHeader?: string; askMulti?: boolean };
  /** Fired when a card is created & sent (session enters waiting-approval).
   *  `key` and `cwd` are carried as two separate, explicit fields — never
   *  collapse them back into one. `key` is the session's registry identity
   *  (matches requestPermission's `key` opt); `cwd` is the real working
   *  directory, threaded through only for the registry's display field
   *  (label = basename(cwd)). Conflating them here is exactly the bug this
   *  split fixes (see resolveKey in bootstrap.ts). */
  onPending?: (p: { key: string; cwd: string; requestId: string; title: string; body: string; toolName: string; askOptions?: AskOption[]; askQuestion?: string; askHeader?: string; askMulti?: boolean }) => void;
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
   *  子 agent 完全透明;想手机远程批子 agent 的人 opt-in 打开(approvals.holdSubagents)。 */
  holdSubagents?: () => boolean;
}

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
    // Policy first: an auto-allow (read-only / trust switch) skips the card even when muted.
    const pd = this.deps.policyDecide({ toolName: opts.toolName, input: opts.input, permissionMode: opts.permissionMode });
    if (pd.decision === 'allow') return { decision: 'allow' };

    // Sub-agent pass-through (方案①): stay transparent for backgrounded/async
    // sub-agents by default (see holdSubagents doc). Holding one blocks it with no
    // parallel local dialog until the window times out — a block CC never has on its
    // own. defer → shim {} → CC-native (local dialog if interactive, else auto-deny).
    // Runs AFTER the policy allow-check, so a safe/trusted sub-agent tool still
    // auto-allows; opt-in holdSubagents makes sub-agent approvals remotely answerable.
    if (opts.agentId && !(this.deps.holdSubagents?.() ?? false)) {
      return { decision: 'defer' };
    }

    // Answer-surface gate: fall back to the local terminal (defer) only when
    // NOBODY can answer remotely. Muting IM (/mute) no longer defers on its own
    // — it just silences the IM card (see push() below); the desktop toast and
    // any live dashboard client remain independent answer paths (IM ⊥ desktop).
    const targets = this.deps.configuredChats();
    const imUsable = targets.length > 0 && !this.deps.isMuted(opts.key);
    if (!imUsable && !this.deps.hasWebClients() && !this.deps.hasLocalAnswerPath()) {
      return { decision: 'defer' };
    }

    const requestId = randomUUID();
    const { title, body, askOptions, askQuestion, askHeader, askMulti } = this.deps.renderCard({ toolName: opts.toolName, input: opts.input });
    const result = await new Promise<{ decision: Decision; message?: string; updatedInput?: unknown }>((resolve) => {
      this.pending.set(requestId, {
        resolve,
        key: opts.key,
        toolName: opts.toolName,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
      });
      setTimeout(() => {
        if (this.pending.has(requestId)) { this.pending.delete(requestId); resolve({ decision: 'defer' }); }
      }, (opts.timeoutSec ?? PERMISSION_TIMEOUT_SEC) * 1000).unref();
      // 调用方死亡 → 放弃该 pending。判据零误判:answer()/cancel() 都先
      // pending.delete() 再 resolve,所以此时 has() 为真 ⟺ 真的没人答过。
      opts.onAbandoned?.(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          resolve({ decision: 'gone' });
        }
      });
      // web 立即 —— dashboard 是 pull 视图,不该等 grace。
      this.deps.onPending?.({
        key: opts.key, cwd: opts.cwd, requestId, title, body, toolName: opts.toolName,
        ...(askOptions ? { askOptions } : {}),
        ...(askQuestion ? { askQuestion } : {}),
        ...(askHeader ? { askHeader } : {}),
        ...(askMulti ? { askMulti } : {}),
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
          void this.deps.sendToChat(t, { title, body, requestId, toolName: opts.toolName, cwd: opts.key, ...(askOptions ? { askOptions } : {}), ...(askMulti ? { askMulti } : {}) }).catch(() => undefined);
        }
      };
      const grace = this.deps.graceSec();
      if (grace > 0) setTimeout(push, grace * 1000).unref();
      else push();
    });
    this.deps.onResolved?.({ key: opts.key, cwd: opts.cwd, requestId, decision: result.decision, ...(result.message ? { message: result.message } : {}), ...(result.updatedInput !== undefined ? { updatedInput: result.updatedInput } : {}) });
    return result;
  }

  /** Approvals currently waiting for an answer (desktop notification count). */
  pendingCount(): number {
    return this.pending.size;
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
    e.resolve({ decision: approved ? 'allow' : 'deny', ...(message ? { message } : {}), ...(updatedInput !== undefined ? { updatedInput } : {}) });
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
      e.resolve({ decision: 'local' }); // onResolved fires from requestPermission's own path
      n++;
    }
    return n;
  }
}
