// src/kernel/daemon/permission-router.ts
import { randomUUID } from 'node:crypto';

export type Decision = 'allow' | 'deny' | 'defer';
export interface PermChat { channel: string; chatId: string }

export interface PermissionRouterDeps {
  configuredChats: () => PermChat[];
  sendToChat: (target: PermChat, card: { title: string; body: string; requestId: string }) => Promise<void>;
  isMuted: () => boolean;
  /** Vendor-neutral policy: allow (auto) vs ask (send card). Never auto-denies. */
  policyDecide: (req: { toolName: string; input: unknown; permissionMode?: string }) => { decision: 'allow' | 'ask'; reason?: string };
  /** Render the approval card body from the normalized request. */
  renderCard: (req: { toolName: string; input: unknown }) => { title: string; body: string };
  /** Fired when a card is created & sent (session enters waiting-approval). */
  onPending?: (p: { cwd: string; requestId: string; title: string; body: string }) => void;
  /** Fired when the request resolves (answered / timed out / deferred after a card). */
  onResolved?: (p: { cwd: string; requestId: string; decision: Decision }) => void;
}

/** Unanswered request auto-defers after this (s). Must be < shim IPC (590s) < hook timeout (600s). */
const PERMISSION_TIMEOUT_SEC = 580;

export class PermissionRouter {
  private pending = new Map<string, (d: Decision) => void>();
  constructor(private deps: PermissionRouterDeps) {}

  async requestPermission(opts: { cwd: string; toolName: string; input: unknown; permissionMode?: string }): Promise<{ decision: Decision }> {
    // Policy first: an auto-allow (read-only / trust switch) skips the card even when muted.
    const pd = this.deps.policyDecide({ toolName: opts.toolName, input: opts.input, permissionMode: opts.permissionMode });
    if (pd.decision === 'allow') return { decision: 'allow' };

    if (this.deps.isMuted()) return { decision: 'defer' };
    const targets = this.deps.configuredChats();
    if (targets.length === 0) return { decision: 'defer' };

    const requestId = randomUUID();
    const { title, body } = this.deps.renderCard({ toolName: opts.toolName, input: opts.input });
    this.deps.onPending?.({ cwd: opts.cwd, requestId, title, body });
    const decision = await new Promise<Decision>((resolve) => {
      this.pending.set(requestId, resolve);
      setTimeout(() => {
        if (this.pending.has(requestId)) { this.pending.delete(requestId); resolve('defer'); }
      }, PERMISSION_TIMEOUT_SEC * 1000).unref();
      for (const t of targets) {
        void this.deps.sendToChat(t, { title, body, requestId }).catch(() => undefined);
      }
    });
    this.deps.onResolved?.({ cwd: opts.cwd, requestId, decision });
    return { decision };
  }

  answer(requestId: string, approved: boolean): void {
    const r = this.pending.get(requestId);
    if (!r) return;
    this.pending.delete(requestId);
    r(approved ? 'allow' : 'deny');
  }
}
