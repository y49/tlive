import type { ChannelType, Button } from '../channels/types.js';

// Structured notification events — IPC protocol between terminal and bridge
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
  | { kind: 'activity_text'; text: string }
  | { kind: 'activity_tool'; toolName: string; toolInput?: string }
  | { kind: 'thinking'; active: boolean }
  | { kind: 'reasoning_summary'; text: string; durationMs?: number; truncated?: boolean }
  | { kind: 'file_change_list'; changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>; status: 'completed' | 'failed' };

// Progress snapshot — produced by MessageRenderer (SDK engine path)
export interface PermissionState {
  toolName: string;
  input: string;
  permId: string;
  buttons: Array<{ label: string; callbackData: string; style: string }>;
}

export interface ProgressSnapshot {
  phase: 'starting' | 'executing' | 'permission' | 'completed' | 'error';
  toolCounts: Map<string, number>;
  totalTools: number;
  elapsedSeconds: number;
  responseText: string;
  permissionQueue: PermissionState[];
  todoItems: TodoItem[];
  costLine?: string;
  errorMessage?: string;
}

// Command response data — structured input for renderCommandResponse
export interface CommandResponseData {
  title: string;
  body?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  color?: 'success' | 'warning' | 'info' | 'error';
  buttons?: Button[];
}

// Platform-specific outbound types
export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
}

export interface TelegramOutbound {
  html: string;
  buttons?: Button[];
}

export interface DiscordOutbound {
  embed: DiscordEmbed;
  buttons?: Button[];
}

export interface FeishuOutbound {
  card: string;  // Card 2.0 JSON string
  buttons?: Button[];
}

export type RenderedMessage = TelegramOutbound | DiscordOutbound | FeishuOutbound;

// Renderer interface — one implementation per platform
export interface NotificationRenderer<T extends RenderedMessage = RenderedMessage> {
  readonly channelType: ChannelType;
  renderNotification(event: NotificationEvent): T;
  renderProgress(snapshot: ProgressSnapshot): T;
  renderCommandResponse(data: CommandResponseData): T;
  renderSimpleText(text: string): T;
}
