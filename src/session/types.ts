// src/session/types.ts
//
// SessionLike abstraction (spec §4.1). Unifies daemon-owned LocalSession
// (drives a full AgentRuntime) and MCP-driven RemoteSession (state pushed
// via tlive-self tool calls). Both implement the same surface so the IM
// frontend and CLI can treat them uniformly.

import type { AgentProvider } from '../runtime/types.js';
import type { NotificationEvent } from '../runtime/events.js';
import type { AgentStatus } from './status.js';
import type { SessionContext } from './context.js';
import type { CostTracker } from '../cost/tracker.js';
import type { ChannelType } from '../workspace/bindings.js';

export type SessionKind = 'local' | 'remote';

/**
 * Identifies the chat that spawned a Session (spec §2 + §4). Carried by
 * LocalSession so frontend fan-out + /sessions filtering + handoff binding
 * lookups can identify the owning chat without scanning bindings.
 */
export interface OwnerChat {
  channelType: ChannelType;
  chatId: string;
  threadId?: string;
}

/** Public snapshot returned by SessionLike.snapshot(). UI-friendly subset. */
export interface SessionInfo {
  id: string;
  shortAlias: string;
  kind: SessionKind;
  provider: AgentProvider;
  workspaceId: string;
  workdir: string;
  title?: string;
  status: AgentStatus;
  cost: {
    totalCost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  createdAt: number;
  lastActivityAt: number;
  /** Chat that spawned this session. RemoteSession may not have one. */
  ownerChat?: OwnerChat;
}

/** Listener fan-out for frontend consumers. */
export type SessionEventKind =
  | { kind: 'event'; event: NotificationEvent }
  | { kind: 'status_change'; status: AgentStatus };

export type SessionEventListener = (ev: SessionEventKind) => void;

export interface SessionLike {
  readonly id: string;
  readonly shortAlias: string;
  readonly kind: SessionKind;
  readonly provider: AgentProvider;
  readonly workspaceId: string;
  readonly workdir: string;
  readonly ctx: SessionContext;
  title: string | undefined;
  status: AgentStatus;
  readonly cost: CostTracker;
  /** True once the SDK-assigned sdkSessionId is known (post-runtime.prepare). */
  readonly isReady: boolean;
  /** Real SDK-reported model id (set on first `system` event). undefined until init. */
  readonly sdkModel?: string;
  /** Max context window for sdkModel (set alongside sdkModel). */
  readonly sdkMaxContextTokens?: number;
  /** Chat that spawned this session (spec §2 + §4). Optional because
   *  RemoteSession does not always have a chat owner. */
  readonly ownerChat?: OwnerChat;

  onEvent(cb: (e: NotificationEvent) => void): () => void;
  onStatusChange(cb: (s: AgentStatus) => void): () => void;
  /** Fires once when the sdkSessionId is first assigned. Idempotent if called post-ready. */
  onSessionIdReady(cb: (id: string) => void): () => void;
  snapshot(): SessionInfo;
}
