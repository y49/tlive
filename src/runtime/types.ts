// src/runtime/types.ts
//
// AgentRuntime contract: the ONLY seam between session layer and
// provider-specific code. See "AgentRuntime contract" section of the plan.

import type { NotificationEvent, UsageStats } from './events.js';

export type AgentProvider = 'claude' | 'codex';

export type PermissionMode = 'default' | 'yolo' | 'safe-yolo' | 'plan' | 'read-only';

export type PermissionDecision = 'allow' | 'deny' | 'allow_always';

export interface PermissionRequest {
  /** Unique permission id, stable across reconnect. Format: `${sessionId}:${toolUseId}`. */
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Resolve with the user's decision. Safe to call exactly once. */
  resolve: (decision: PermissionDecision) => void;
}

export interface AgentRuntimeOptions {
  sessionId: string;
  workdir: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  permissionMode?: PermissionMode;
  /** Optional first prompt; runtime queues it as the first turn. */
  initialPrompt?: string;
  /** When aborted, runtime drains stream and emits session_complete/error. */
  signal: AbortSignal;
}

export interface AgentRuntime {
  readonly provider: AgentProvider;

  /** Initialize underlying SDK/transport. Idempotent within instance lifetime — throws on second call. */
  start(opts: AgentRuntimeOptions): Promise<void>;

  /** Send a user message. Runtime decides whether this opens a new turn or steers an active one. */
  sendInput(text: string): Promise<void>;

  /** Drain + close. Safe to call multiple times. */
  stop(): Promise<void>;

  onEvent(cb: (e: NotificationEvent) => void): () => void;
  onPermissionRequest(cb: (req: PermissionRequest) => void): () => void;
  onUsage(cb: (usage: UsageStats) => void): () => void;
}
