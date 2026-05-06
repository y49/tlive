// src/im/workspace-create-broker.ts
//
// Per-chat singleton pending state for the "input workspace path" dialog.
// Sister broker to AskUserQuestionBroker (see permission/ask-broker.ts) —
// uses the same plain-text-relay pattern in handleInbound.
//
// Lifecycle:
//   user clicks [➕ 新增工作区] (callback workspace:create:start)
//     → callback router calls broker.start(...)
//     → bot replies "请发送项目根目录绝对路径..."
//   user sends plain text path
//     → bootstrap inbound checks broker.pendingFor()
//     → matched + same userId → tryCreateWorkspaceFromPath
//     → broker.resolve() removes pending state
//   user sends "/cancel" (or clicks [❌ 取消])
//     → broker.cancel()
//   timeout (5 min)
//     → broker.pruneExpired() removes stale entries

import type { ChannelType } from '../workspace/bindings.js';

export interface PendingCreate {
  channelType: ChannelType;
  chatId: string;
  userId: string;
  triggerMessageId: string;
  /** ms epoch; defaults to Date.now() at start() */
  startedAtMs?: number;
}

export class WorkspaceCreateBroker {
  private pending = new Map<string, PendingCreate>();

  private key(channelType: ChannelType, chatId: string): string {
    return `${channelType}:${chatId}`;
  }

  /** Begin a pending workspace-create dialog for this chat. Replaces
   *  any existing pending state for the same chat. */
  start(p: PendingCreate): void {
    this.pending.set(this.key(p.channelType, p.chatId), {
      ...p,
      startedAtMs: p.startedAtMs ?? Date.now(),
    });
  }

  pendingFor(channelType: ChannelType, chatId: string): PendingCreate | undefined {
    return this.pending.get(this.key(channelType, chatId));
  }

  resolve(channelType: ChannelType, chatId: string): void {
    this.pending.delete(this.key(channelType, chatId));
  }

  cancel(channelType: ChannelType, chatId: string): void {
    this.pending.delete(this.key(channelType, chatId));
  }

  /** Remove entries older than maxAgeMs. Returns count removed. */
  pruneExpired(maxAgeMs: number): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of this.pending) {
      if (now - (v.startedAtMs ?? 0) > maxAgeMs) {
        this.pending.delete(k);
        removed++;
      }
    }
    return removed;
  }

  /** Test helper. */
  size(): number {
    return this.pending.size;
  }
}
