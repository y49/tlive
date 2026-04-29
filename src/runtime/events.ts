// src/runtime/events.ts
//
// Source of truth for the runtime event contract (spec §3.4).
// Every AgentRuntime.onEvent emits exactly these shapes. Adding a variant:
// update here, then expand both event adapters + every renderer before merging.

import type { PermissionCategory, PermissionDecision } from './types.js';
import type { AgentStatus } from '../session/status.js';

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd: number;
}

export type NotificationEvent =
  | { kind: 'turn_start'; turnId: string; userInputPreview: string; at: number }
  | { kind: 'turn_end'; turnId: string; durationMs: number; costUsd: number; tokensIn: number; tokensOut: number }
  | { kind: 'status_change'; status: AgentStatus }
  | { kind: 'heartbeat'; elapsedMs: number }
  | { kind: 'assistant_text_delta'; turnId: string; text: string; partial: true }
  | { kind: 'assistant_text'; turnId: string; text: string; complete: true }
  | { kind: 'thinking_delta'; turnId: string; text: string; partial: true }
  | { kind: 'thinking_end'; turnId: string; totalTokens: number }
  | { kind: 'tool_use_start'; turnId: string; toolUseId: string; toolName: string; input: unknown; batchId?: string; batchIndex?: number; batchSize?: number }
  | { kind: 'tool_use_result'; toolUseId: string; output: unknown; durationMs: number; ok: boolean; overflowAttachmentId?: string }
  | { kind: 'parallel_tool_batch_start'; batchId: string; count: number }
  | { kind: 'parallel_tool_batch_end'; batchId: string }
  | { kind: 'subagent_start'; agentId: string; parentTurnId: string; description: string; taskId: string }
  | { kind: 'subagent_progress'; agentId: string; summary: string }
  | { kind: 'subagent_event'; agentId: string; event: NotificationEvent }
  | { kind: 'subagent_stop'; agentId: string; taskId: string; ok: boolean }
  | { kind: 'file_changed'; path: string; op: 'created' | 'modified' | 'deleted'; diff?: string; userMessageId?: string }
  | { kind: 'attachment_produced'; attachmentId: string; name: string; mime: string; sizeBytes: number; path: string }
  | { kind: 'todo_write'; items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; id?: string }> }
  | { kind: 'prompt_suggestion'; turnId: string; suggestions: Array<{ id: string; text: string }> }
  | { kind: 'ask_user_question_requested'; requestId: string; prompt: string; options: string[] }
  | { kind: 'ask_user_question_resolved'; requestId: string; chosen: string[] }
  | { kind: 'elicitation_requested'; requestId: string; mcpServerName: string; description?: string; schema?: unknown }
  | { kind: 'elicitation_resolved'; requestId: string; action: 'accept' | 'decline'; content?: unknown }
  | { kind: 'permission_requested'; requestId: string; category: PermissionCategory; toolName: string; toolInput: unknown }
  | { kind: 'permission_resolved'; requestId: string; decision: PermissionDecision; resolvedByUserId?: string }
  | { kind: 'pre_compact'; droppedMessages: number; keptMessages: number }
  | { kind: 'post_compact'; tokensSaved: number }
  | { kind: 'cache_warmth_change'; warmUntilMs: number | null }
  | { kind: 'prewarm_tick'; atMs: number }
  | { kind: 'api_throttle'; retryAfterMs: number; message: string }
  | { kind: 'api_resumed' }
  | { kind: 'rewind_files'; userMessageId: string; restored: number; skipped: number }
  | { kind: 'session_forked'; newSdkSessionId: string; title: string }
  | { kind: 'session_renamed'; title: string }
  | { kind: 'mcp_status_change'; server: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' }
  | { kind: 'plugin_reloaded'; commandsAdded: string[]; commandsRemoved: string[] }
  | { kind: 'hook_generic'; event: string; payload: unknown }
  | { kind: 'session_complete'; reason: string; summary: string }
  | { kind: 'runtime_error'; severity: 'warn' | 'fatal'; code: string; message: string; retryHintMs?: number }
  | { kind: 'usage'; turnId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }
  | { kind: 'quota_update'; quotaBars: Array<{ label: string; pct: number; resetsIn?: string }> };
