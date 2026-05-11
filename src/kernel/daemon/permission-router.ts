// src/kernel/daemon/permission-router.ts

import { randomUUID } from 'node:crypto';
import type { WorkspaceRegistry } from '../workspace/registry.js';

export interface PermissionRouterDeps {
  workspaces: WorkspaceRegistry;
  /** Bound chats per workspaceId; falsy = none bound. */
  chatsForWorkspace?: (workspaceId: string) => Array<{ channel: string; chatId: string }>;
  /** Push card to one IM chat. */
  sendToChat?: (target: { channel: string; chatId: string }, card: { title: string; body: string; requestId: string }) => Promise<void>;
}

export interface PermissionResult {
  approved: boolean;
  reason?: string;
}

export class PermissionRouter {
  /** pid → workspaceId attached. */
  private attached = new Map<number, string>();
  /** requestId → resolve. */
  private pending = new Map<string, (r: PermissionResult) => void>();

  constructor(private deps: PermissionRouterDeps) {}

  attach(opts: { cwd: string; pid: number }): string | null {
    const ws = this.deps.workspaces.lookupByCwd(opts.cwd);
    if (!ws) return null;
    this.attached.set(opts.pid, ws.id);
    return ws.id;
  }

  detach(pid: number): void { this.attached.delete(pid); }

  async requestPermission(opts: { pid: number; toolName: string; input: unknown }): Promise<PermissionResult> {
    const wsId = this.attached.get(opts.pid);
    if (!wsId) return { approved: false, reason: 'pid not attached' };
    const targets = this.deps.chatsForWorkspace?.(wsId) ?? [];
    if (targets.length === 0) {
      return { approved: false, reason: `no IM chat bound for workspace ${wsId}` };
    }
    const requestId = randomUUID();
    const result = await new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, resolve);
      // Fire-and-forget push to all bound chats; first answer wins.
      for (const t of targets) {
        void this.deps.sendToChat?.(t, {
          title: `Permission: ${opts.toolName}`,
          body: `tool input: ${JSON.stringify(opts.input).slice(0, 500)}`,
          requestId,
        }).catch(() => undefined);
      }
    });
    return result;
  }

  /** Called when IM responds via callback button or `/approve` text. */
  answer(requestId: string, approved: boolean): void {
    const r = this.pending.get(requestId);
    if (!r) return;
    this.pending.delete(requestId);
    r({ approved });
  }
}
