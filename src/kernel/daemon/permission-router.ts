// src/kernel/daemon/permission-router.ts
import { randomUUID } from 'node:crypto';

export type Decision = 'allow' | 'deny' | 'defer';
export interface PermChat { channel: string; chatId: string }

export interface PermissionRouterDeps {
  /** Notification destinations (one per configured channel). */
  configuredChats: () => PermChat[];
  /** Push an approval card to one IM chat. */
  sendToChat: (target: PermChat, card: { title: string; body: string; requestId: string }) => Promise<void>;
  /** Global notification mute (`/perm off`). When muted, requests auto-defer. */
  isMuted: () => boolean;
}

/** Timeout before an unanswered request auto-defers (seconds).
 *  Must be < the shim's IPC timeout (290 s for PreToolUse). */
const PERMISSION_TIMEOUT_SEC = 250;

export class PermissionRouter {
  private pending = new Map<string, (d: Decision) => void>();
  constructor(private deps: PermissionRouterDeps) {}

  async requestPermission(opts: { cwd: string; toolName: string; input: unknown }): Promise<{ decision: Decision }> {
    if (this.deps.isMuted()) return { decision: 'defer' };
    const targets = this.deps.configuredChats();
    if (targets.length === 0) return { decision: 'defer' };
    const requestId = randomUUID();
    const decision = await new Promise<Decision>((resolve) => {
      this.pending.set(requestId, resolve);
      setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          resolve('defer');
        }
      }, PERMISSION_TIMEOUT_SEC * 1000).unref();
      for (const t of targets) {
        void this.deps.sendToChat(t, {
          title: `权限请求: ${opts.toolName}`,
          body: JSON.stringify(opts.input).slice(0, 500),
          requestId,
        }).catch(() => undefined);
      }
    });
    return { decision };
  }

  answer(requestId: string, approved: boolean): void {
    const r = this.pending.get(requestId);
    if (!r) return;
    this.pending.delete(requestId);
    r(approved ? 'allow' : 'deny');
  }
}
