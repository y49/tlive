// src/runtime/claude/event-adapter.ts
//
// Maps raw Claude Agent SDK stream messages to NotificationEvent. T1 keeps
// this deliberately minimal — enough to surface init + result + basic
// assistant/thinking events so runtime.ts can compile and integration runs.
// T2 replaces the body with full union coverage (tool_use, todo_update,
// file_change_list, ask_user_question, etc).

import type { NotificationEvent, TodoItem, UsageStats } from '../events.js';
import type { AskUserQuestionRequest } from '../types.js';

type SdkMessage = { type: string; [k: string]: unknown };

export interface AdaptedFrame {
  events: NotificationEvent[];
  usage?: UsageStats;
  askUserQuestion?: AskUserQuestionRequest;
  isSessionEnd?: boolean;
}

export class ClaudeEventAdapter {
  adapt(msg: SdkMessage): AdaptedFrame {
    switch (msg.type) {
      case 'assistant':
        return { events: this.fromAssistant(msg) };
      case 'user':
        return { events: [] };
      case 'result':
        return this.fromResult(msg);
      case 'thinking':
        return { events: [{ kind: 'thinking', active: true }] };
      case 'system':
        return { events: [] };
      default:
        return { events: [] };
    }
  }

  private fromAssistant(msg: SdkMessage): NotificationEvent[] {
    const message = msg.message as { content?: Array<{ type: string; [k: string]: unknown }> } | undefined;
    const out: NotificationEvent[] = [];
    for (const block of message?.content ?? []) {
      if (block.type === 'text') {
        const text = (block as unknown as { text: string }).text;
        if (text) out.push({ kind: 'activity_text', text });
      } else if (block.type === 'tool_use') {
        const toolName = (block as unknown as { name: string }).name;
        const inputJson = safeStringify((block as unknown as { input: unknown }).input);
        if (toolName === 'TodoWrite') {
          const items = extractTodos((block as unknown as { input: unknown }).input);
          if (items) out.push({ kind: 'todo_update', items });
        } else {
          out.push({ kind: 'activity_tool', toolName, toolInput: inputJson });
        }
      } else if (block.type === 'thinking') {
        const text = (block as unknown as { thinking?: string }).thinking;
        if (text) out.push({ kind: 'reasoning_summary', text });
      }
    }
    return out;
  }

  private fromResult(msg: SdkMessage): AdaptedFrame {
    const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const cost = msg.total_cost_usd as number | undefined;
    const duration = msg.duration_ms as number | undefined;
    const summary = (msg.result as string) ?? '';
    return {
      events: [{ kind: 'session_complete', summary }],
      usage: usage ? {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        costUsd: cost ?? 0,
        durationMs: duration ?? 0,
      } : undefined,
      isSessionEnd: false,
    };
  }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return '[unserializable]'; }
}

function extractTodos(input: unknown): TodoItem[] | null {
  if (!input || typeof input !== 'object') return null;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;
  const out: TodoItem[] = [];
  for (const t of todos) {
    if (t && typeof t === 'object' && 'content' in t && 'status' in t) {
      out.push({
        content: String((t as { content: unknown }).content),
        status: (t as { status: TodoItem['status'] }).status,
      });
    }
  }
  return out.length > 0 ? out : null;
}
