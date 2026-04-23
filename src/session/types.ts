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

export type SessionKind = 'local' | 'remote';

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
  /** True once the SDK-assigned sdkSessionId is known (post-runtime.start). */
  readonly isReady: boolean;

  onEvent(cb: (e: NotificationEvent) => void): () => void;
  onStatusChange(cb: (s: AgentStatus) => void): () => void;
  /** Fires once when the sdkSessionId is first assigned. Idempotent if called post-ready. */
  onSessionIdReady(cb: (id: string) => void): () => void;
  snapshot(): SessionInfo;
}
