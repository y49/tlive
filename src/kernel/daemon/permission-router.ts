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
}

/** Unanswered request auto-defers after this (s). Must be < shim IPC (590s) < hook timeout (600s). */
const PERMISSION_TIMEOUT_SEC = 580;

interface PendingEntry {
  resolve: (d: Decision) => void;
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

  async requestPermission(opts: { cwd: string; toolName: string; input: unknown; permissionMode?: string; timeoutSec?: number; sessionId?: string; agentId?: string }): Promise<{ decision: Decision }> {
    // Policy first: an auto-allow (read-only / trust switch) skips the card even when muted.
    const pd = this.deps.policyDecide({ toolName: opts.toolName, input: opts.input, permissionMode: opts.permissionMode });
    if (pd.decision === 'allow') return { decision: 'allow' };

    if (this.deps.isMuted(opts.cwd)) return { decision: 'defer' };
    const targets = this.deps.configuredChats();
    // Web-only users still get the card via onPending → /ws/events broadcast.
    if (targets.length === 0 && !this.deps.hasWebClients()) return { decision: 'defer' };

    const requestId = randomUUID();
    const { title, body } = this.deps.renderCard({ toolName: opts.toolName, input: opts.input });
    const decision = await new Promise<Decision>((resolve) => {
      this.pending.set(requestId, {
        resolve,
        key: opts.cwd,
        toolName: opts.toolName,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
      });
      setTimeout(() => {
        if (this.pending.has(requestId)) { this.pending.delete(requestId); resolve('defer'); }
      }, (opts.timeoutSec ?? PERMISSION_TIMEOUT_SEC) * 1000).unref();
      // After pending registration: an answer() from the broadcast path resolves.
      this.deps.onPending?.({ cwd: opts.cwd, requestId, title, body, toolName: opts.toolName });
      for (const t of targets) {
        void this.deps.sendToChat(t, { title, body, requestId, toolName: opts.toolName, cwd: opts.cwd }).catch(() => undefined);
      }
    });
    this.deps.onResolved?.({ cwd: opts.cwd, requestId, decision });
    return { decision };
  }

  answer(requestId: string, approved: boolean): void {
    const e = this.pending.get(requestId);
    if (!e) return;
    this.pending.delete(requestId);
    e.resolve(approved ? 'allow' : 'deny');
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
      e.resolve('local'); // onResolved fires from requestPermission's own path
      n++;
    }
    return n;
  }
}
