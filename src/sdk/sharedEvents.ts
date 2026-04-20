// src/sdk/sharedEvents.ts
// Shared IPC event types mirroring bridge/src/renderers/types.ts.
// Kept in sync manually; Task 6 will consolidate.

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
  | { kind: 'session_complete'; summary: string; cost?: UsageStats; terminalUrl?: string; resumeHint?: string }
  | { kind: 'error'; message: string }
  | { kind: 'todo_update'; items: TodoItem[] }
  | { kind: 'activity_text'; text: string; title?: string; footer?: string; terminalUrl?: string }
  | { kind: 'activity_tool'; toolName: string; toolInput?: string; terminalUrl?: string }
  | { kind: 'thinking'; active: boolean }
  | { kind: 'reasoning_summary'; text: string; durationMs?: number; truncated?: boolean }
  | { kind: 'file_change_list'; changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>; status: 'completed' | 'failed' };
