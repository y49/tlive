// src/kernel/permission/broker.ts

import { randomUUID } from 'node:crypto';
import type { PermissionRequest, PermissionSource } from './types.js';

interface Pending {
  resolve: (approved: boolean) => void;
}

export class PermissionBroker {
  private pending = new Map<string, Pending>();
  private requestHandler?: (req: PermissionRequest) => void;

  onRequest(handler: (req: PermissionRequest) => void): void {
    this.requestHandler = handler;
  }

  /** Used by both MCP `approve` tool and Runtime SDK callback. Returns approved boolean. */
  request(opts: { toolName: string; input: unknown; source: PermissionSource }): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      this.pending.set(requestId, { resolve });
      this.requestHandler?.({ requestId, toolName: opts.toolName, input: opts.input, source: opts.source });
    });
  }

  /** Called when IM (or CLI fallback) responds. */
  answer(requestId: string, approved: boolean): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    p.resolve(approved);
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
