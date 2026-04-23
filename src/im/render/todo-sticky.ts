// src/im/render/todo-sticky.ts
//
// Anchor #6 — per-session todo sticky (spec §7.3). Pinned when the platform
// supports it, otherwise auto-rebroadcast (delete + re-send to bottom) on
// every update so the user doesn't have to scroll up.
//
// v1.0 — renderer-per-target. Also: on non-pin platforms, burst todo_write
// events are debounced (1.5s) to avoid noisy delete+resend cycles.
//
// Content:
//   📋 Todo (2/5)
//    ✅ Read auth files
//    ⏳ Fix cookie validation
//    ⬜ Run tests

import type { RendererDeps, SessionRenderState, RenderTarget } from './types.js';
import { targetKey } from './types.js';

export const TODO_REBROADCAST_DEBOUNCE_MS = 1500;

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  id?: string;
}

function glyphFor(status: TodoStatus): string {
  switch (status) {
    case 'completed': return '✅';
    case 'in_progress': return '⏳';
    case 'pending': return '⬜';
  }
}

export function renderTodoText(items: readonly TodoItem[]): string {
  if (items.length === 0) return '📋 Todo (empty)';
  const completed = items.filter((t) => t.status === 'completed').length;
  const header = `📋 Todo (${completed}/${items.length})`;
  const lines = items.map((t) => ` ${glyphFor(t.status)} ${t.content}`);
  return [header, ...lines].join('\n');
}

export interface TodoStickyRendererOptions extends RendererDeps {
  session: SessionRenderState;
  clock?: () => number;
  timers?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
}

export class TodoStickyRenderer {
  private readonly adapter: TodoStickyRendererOptions['adapter'];
  private readonly capabilities: TodoStickyRendererOptions['capabilities'];
  private readonly session: SessionRenderState;
  private readonly target: RenderTarget;
  private readonly clock: () => number;
  private readonly timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  /** Per-target pending update (rebroadcast mode). */
  private pendingItems: readonly TodoItem[] | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRenderMs = 0;

  constructor(opts: TodoStickyRendererOptions) {
    this.adapter = opts.adapter;
    this.capabilities = opts.capabilities;
    this.session = opts.session;
    this.target = opts.target;
    this.clock = opts.clock ?? (() => Date.now());
    this.timers = opts.timers ?? { setTimeout, clearTimeout };
  }

  async update(items: readonly TodoItem[]): Promise<void> {
    this.session.todoItems = [...items];
    // Pin+edit platforms render immediately (edit is cheap, idempotent).
    if (this.capabilities.pinMessage) {
      await this.renderNow(items);
      return;
    }
    // Rebroadcast mode: debounce bursts to avoid delete+send storms.
    this.pendingItems = items;
    const now = this.clock();
    const sinceLast = now - this.lastRenderMs;
    if (sinceLast >= TODO_REBROADCAST_DEBOUNCE_MS && !this.debounceTimer) {
      // Enough time has elapsed — render now, clear pending.
      await this.flushPending();
      return;
    }
    if (!this.debounceTimer) {
      const delay = Math.max(0, TODO_REBROADCAST_DEBOUNCE_MS - sinceLast);
      this.debounceTimer = this.timers.setTimeout(() => {
        this.debounceTimer = undefined;
        void this.flushPending().catch(() => { /* isolate */ });
      }, delay);
    }
  }

  async teardown(): Promise<void> {
    if (this.debounceTimer) {
      this.timers.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.pendingItems = undefined;
    const target = this.target;
    const key = targetKey(target);
    const id = this.session.todoMsgIds.get(key);
    if (!id) return;
    try { await this.adapter.delete(id, target.chatId); } catch { /* isolate */ }
    this.session.todoMsgIds.delete(key);
  }

  private async flushPending(): Promise<void> {
    const items = this.pendingItems;
    if (!items) return;
    this.pendingItems = undefined;
    await this.renderNow(items);
  }

  private async renderNow(items: readonly TodoItem[]): Promise<void> {
    this.lastRenderMs = this.clock();
    const text = renderTodoText(items);
    await this.renderForTarget(text);
  }

  private async renderForTarget(text: string): Promise<void> {
    const target = this.target;
    const key = targetKey(target);
    const existing = this.session.todoMsgIds.get(key);

    if (this.capabilities.pinMessage && existing && this.capabilities.editMessage) {
      // Pinned-edit mode: edit in place.
      try {
        await this.adapter.edit(existing, target.chatId, text);
        return;
      } catch { /* fall through to rebroadcast */ }
    }

    // Rebroadcast mode: delete old + send fresh so it sits at bottom.
    if (existing) {
      try { await this.adapter.delete(existing, target.chatId); } catch { /* isolate */ }
      this.session.todoMsgIds.delete(key);
    }
    const sent = await this.adapter.send({
      chatId: target.chatId,
      threadId: target.threadId,
      text,
      silent: true,
    });
    this.session.todoMsgIds.set(key, sent);
    if (this.capabilities.pinMessage) {
      try { await this.adapter.pin(sent, target.chatId); } catch { /* isolate */ }
    }
  }
}
