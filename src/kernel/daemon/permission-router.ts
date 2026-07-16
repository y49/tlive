// src/kernel/daemon/permission-router.ts
import { randomUUID } from 'node:crypto';

/** 'local' = the user answered in the local terminal; the IPC layer maps it to
 *  'defer' on the wire (shim outputs pass-through {}) — never an auto-allow. */
export type Decision = 'allow' | 'deny' | 'defer' | 'local';
export interface PermChat { channel: string; chatId: string }

export interface PermissionRouterDeps {
  configuredChats: () => PermChat[];
  sendToChat: (target: PermChat, card: { title: string; body: string; requestId: string; toolName: string; cwd: string }) => Promise<void>;
  isMuted: (cwd: string) => boolean;
  /** True when at least one dashboard client is connected on /ws/events —
   *  a card can be answered from the web even with zero IM chats. */
  hasWebClients: () => boolean;
  /** Vendor-neutral policy: allow (auto) vs ask (send card). Never auto-denies. */
  policyDecide: (req: { toolName: string; input: unknown; permissionMode?: string }) => { decision: 'allow' | 'ask'; reason?: string };
  /** Render the approval card body from the normalized request. */
  renderCard: (req: { toolName: string; input: unknown }) => { title: string; body: string };
  /** Fired when a card is created & sent (session enters waiting-approval). */
  onPending?: (p: { cwd: string; requestId: string; title: string; body: string; toolName: string }) => void;
  /** Fired when the request resolves (answered / timed out / deferred after a card). */
  onResolved?: (p: { cwd: string; requestId: string; decision: Decision }) => void;
  /** 发 IM 卡前的静默期(秒)。本地秒答的审批在此窗口内 cancel → 卡永不发出
   *  (键盘前零刷屏)。0 = 立即发。web 广播(onPending)不受影响。 */
  graceSec: () => number;
}

/** Unanswered request auto-defers after this (s). Must be < shim IPC (590s) < hook timeout (600s). */
const PERMISSION_TIMEOUT_SEC = 580;

interface PendingEntry {
  resolve: (d: { decision: Decision; message?: string }) => void;
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

  async requestPermission(opts: { cwd: string; toolName: string; input: unknown; permissionMode?: string; timeoutSec?: number; sessionId?: string; agentId?: string }): Promise<{ decision: Decision; message?: string }> {
    // Policy first: an auto-allow (read-only / trust switch) skips the card even when muted.
    const pd = this.deps.policyDecide({ toolName: opts.toolName, input: opts.input, permissionMode: opts.permissionMode });
    if (pd.decision === 'allow') return { decision: 'allow' };

    if (this.deps.isMuted(opts.cwd)) return { decision: 'defer' };
    const targets = this.deps.configuredChats();
    // Web-only users still get the card via onPending → /ws/events broadcast.
    if (targets.length === 0 && !this.deps.hasWebClients()) return { decision: 'defer' };

    const requestId = randomUUID();
    const { title, body } = this.deps.renderCard({ toolName: opts.toolName, input: opts.input });
    const result = await new Promise<{ decision: Decision; message?: string }>((resolve) => {
      this.pending.set(requestId, {
        resolve,
        key: opts.cwd,
        toolName: opts.toolName,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
      });
      setTimeout(() => {
        if (this.pending.has(requestId)) { this.pending.delete(requestId); resolve({ decision: 'defer' }); }
      }, (opts.timeoutSec ?? PERMISSION_TIMEOUT_SEC) * 1000).unref();
      // web 立即 —— dashboard 是 pull 视图,不该等 grace。
      this.deps.onPending?.({ cwd: opts.cwd, requestId, title, body, toolName: opts.toolName });
      // IM 卡走 grace:开火时 pending 还在才发。cancel()/answer() 都先 delete
      // 再 resolve,所以这一句就是权威判据,不需要额外的取消令牌。
      const push = (): void => {
        if (!this.pending.has(requestId)) return;
        if (this.deps.isMuted(opts.cwd)) return; // grace 期间 mute 了 → 尊重
        for (const t of targets) {
          void this.deps.sendToChat(t, { title, body, requestId, toolName: opts.toolName, cwd: opts.cwd }).catch(() => undefined);
        }
      };
      const grace = this.deps.graceSec();
      if (grace > 0) setTimeout(push, grace * 1000).unref();
      else push();
    });
    this.deps.onResolved?.({ cwd: opts.cwd, requestId, decision: result.decision });
    return result;
  }

  answer(requestId: string, approved: boolean, message?: string): void {
    const e = this.pending.get(requestId);
    if (!e) return;
    this.pending.delete(requestId);
    e.resolve({ decision: approved ? 'allow' : 'deny', ...(message ? { message } : {}) });
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
