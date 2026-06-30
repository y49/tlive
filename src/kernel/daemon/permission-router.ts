// src/kernel/daemon/permission-router.ts

import { randomUUID } from 'node:crypto';
import type { WorkspaceRegistry } from '../workspace/registry.js';

export interface PermissionRouterDeps {
  workspaces: WorkspaceRegistry;
  /** Bound chats per workspaceId. */
  chatsForWorkspace: (workspaceId: string) => Array<{ channel: string; chatId: string }>;
  /** Push approval card to one IM chat. */
  sendToChat: (target: { channel: string; chatId: string }, card: { title: string; body: string; requestId: string }) => Promise<void>;
}

export type Decision = 'allow' | 'deny' | 'defer';

/** Timeout before an unanswered permission request auto-defers (seconds).
 *  Must be less than the shim's IPC timeout (290 s for PreToolUse). */
const PERMISSION_TIMEOUT_SEC = 250;

export class PermissionRouter {
  /** requestId → resolve. */
  private pending = new Map<string, (d: Decision) => void>();

  constructor(private deps: PermissionRouterDeps) {}

  async requestPermission(opts: { cwd: string; toolName: string; input: unknown }): Promise<{ decision: Decision }> {
    const ws = this.deps.workspaces.lookupByCwd(opts.cwd);
    if (!ws) return { decision: 'defer' };
    const targets = this.deps.chatsForWorkspace(ws.id);
    if (targets.length === 0) return { decision: 'defer' };
    const requestId = randomUUID();
    const decision = await new Promise<Decision>((resolve) => {
      this.pending.set(requestId, resolve);
      // Bounded timeout: resolve 'defer' so pending never leaks (e.g. write to closed socket).
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

  /** Called when IM button callback or CLI approve arrives. */
  answer(requestId: string, approved: boolean): void {
    const r = this.pending.get(requestId);
    if (!r) return;
    this.pending.delete(requestId);
    r(approved ? 'allow' : 'deny');
  }
}
