// src/runtime/claude-event-adapter.ts
//
// Maps raw Claude Agent SDK stream messages to NotificationEvent.
// Pure function — no I/O, no timers, no mutable state beyond the per-call
// accumulator (e.g., matching tool_use_start with tool_use_end).

import type { NotificationEvent, TodoItem, UsageStats } from './events.js';

// SDK payload shapes (loosely typed — the SDK exports its own types; we accept `unknown`
// and narrow defensively so a shape change in the SDK doesn't crash the daemon).
type SdkMessage = { type: string; [k: string]: unknown };

export interface AdaptedFrame {
  events: NotificationEvent[];
  usage?: UsageStats;
  isSessionEnd?: boolean;
}

export class ClaudeEventAdapter {
  adapt(msg: SdkMessage): AdaptedFrame {
    switch (msg.type) {
      case 'assistant':
        return { events: this.fromAssistant(msg) };
      case 'user':
        return { events: this.fromUserToolResult(msg) };
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

  private fromUserToolResult(msg: SdkMessage): NotificationEvent[] {
    // tool_result blocks; we mostly ignore for UI, but file-change tools emit file_change_list.
    const message = msg.message as { content?: Array<{ type: string; [k: string]: unknown }> } | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === 'tool_result') {
        const toolUseId = (block as unknown as { tool_use_id?: string }).tool_use_id;
        const meta = (msg.toolUseMeta as Record<string, { toolName?: string }> | undefined)?.[toolUseId ?? ''];
        if (meta?.toolName === 'Edit' || meta?.toolName === 'Write' || meta?.toolName === 'MultiEdit') {
          // Placeholder: extracting actual file paths is tool-specific — leave for follow-up
        }
      }
    }
    return [];
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
      isSessionEnd: false,  // result per-turn; true session-end detected by AbortSignal
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
      out.push({ content: String((t as { content: unknown }).content), status: (t as { status: TodoItem['status'] }).status });
    }
  }
  return out.length > 0 ? out : null;
}
