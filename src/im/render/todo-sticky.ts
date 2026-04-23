// src/im/render/todo-sticky.ts
//
// Anchor #6 — per-session todo sticky (spec §7.3). Pinned when the platform
// supports it, otherwise auto-rebroadcast (delete + re-send to bottom) on
// every update so the user doesn't have to scroll up.
//
// Content:
//   📋 Todo (2/5)
//    ✅ Read auth files
//    ⏳ Fix cookie validation
//    ⬜ Run tests

import type { RendererDeps, SessionRenderState, RenderTarget } from './types.js';
import { targetKey } from './types.js';

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
}

export class TodoStickyRenderer {
  private readonly adapter: TodoStickyRendererOptions['adapter'];
  private readonly capabilities: TodoStickyRendererOptions['capabilities'];
  private readonly session: SessionRenderState;

  constructor(opts: TodoStickyRendererOptions) {
    this.adapter = opts.adapter;
    this.capabilities = opts.capabilities;
    this.session = opts.session;
  }

  async update(items: readonly TodoItem[]): Promise<void> {
    this.session.todoItems = [...items];
    const text = renderTodoText(items);
    for (const target of this.session.targets) {
      await this.renderForTarget(target, text);
    }
  }

  async teardown(): Promise<void> {
    for (const target of this.session.targets) {
      const key = targetKey(target);
      const id = this.session.todoMsgIds.get(key);
      if (!id) continue;
      try { await this.adapter.delete(id, target.chatId); } catch { /* isolate */ }
      this.session.todoMsgIds.delete(key);
    }
  }

  private async renderForTarget(target: RenderTarget, text: string): Promise<void> {
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
