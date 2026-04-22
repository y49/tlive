// src/runtime/events.ts
//
// Source of truth for the runtime event contract.
// Every AgentRuntime.onEvent emits exactly these shapes. The bridge's
// renderers consume the same union (currently a structural duplicate in
// bridge/src/renderers/types.ts — TS6059 blocks a cross-rootDir re-export;
// Phase 3 T14 consolidates).
//
// Adding a variant: add here first, then handle it in every renderer
// (telegram/discord/feishu) before merging.

export interface AskOption {
  label: string;
  description?: string;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export type NotificationEvent =
  | { kind: 'permission_request'; toolName: string; toolInput: string; permissionId: string; expiresInMinutes?: number }
  | { kind: 'ask_user_question'; question: string; header?: string; options?: AskOption[]; toolUseId: string }
  | { kind: 'session_complete'; summary: string; cost?: UsageStats }
  | { kind: 'error'; message: string }
  | { kind: 'todo_update'; items: TodoItem[] }
  | { kind: 'activity_text'; text: string; title?: string; footer?: string }
  | { kind: 'activity_tool'; toolName: string; toolInput?: string }
  | { kind: 'thinking'; active: boolean }
  | { kind: 'reasoning_summary'; text: string; durationMs?: number; truncated?: boolean }
  | { kind: 'file_change_list'; changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>; status: 'completed' | 'failed' };
