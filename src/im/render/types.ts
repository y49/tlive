// src/im/render/types.ts
//
// Shared renderer types. SessionRenderState holds the per-session book-keeping
// used by renderers to track message ids and react to turn phases.
// Dead fields removed post-T10b (TurnRenderState, ParallelToolEntry,
// SubagentEntry, PermissionTemplateInput, and 8 unused SessionRenderState
// fields) — see refactor(im): trim SessionRenderState commit.

import type { ChannelType } from '../../workspace/chat-instance.js';
import type { PlatformAdapter } from '../../platform/types.js';
import type { ChannelCapabilities } from '../capability-matrix.js';

/** Destination (workspace binding) for a renderer. */
export interface RenderTarget {
  channelType: ChannelType;
  chatId: string;
  threadId?: string;
  /** primary receives buttons; mirrors get read-only echoes. */
  role: 'primary' | 'mirror';
}

/**
 * Cross-turn state per session. Tracks message ids and reaction anchors.
 */
export interface SessionRenderState {
  sessionId: string;
  shortAlias: string;
  workspaceId: string;
  workspaceName: string;
  /** All render targets for this session (used by tests + internal helpers). */
  targets: RenderTarget[];
  /** pending elicitations → msg ids per-target (targetKey → requestId → msgId). */
  pendingElicitationMsgIds: Map<string, Map<string, string>>;
  /**
   * Most-recent inbound message coordinates per render target (keyed by
   * targetKey). SessionFrontend records this on `markInboundReceived` so
   * later turn_start / turn_end / runtime_error can update the reaction
   * emoji on the right user message. Cleared per target when the session
   * detaches.
   */
  lastInboundByTarget: Map<string, { chatId: string; messageId: string; threadId?: string }>;
}

export interface RendererDeps {
  adapter: PlatformAdapter;
  capabilities: ChannelCapabilities;
  /**
   * The specific RenderTarget this renderer instance is bound to.
   *
   * v1.0 — per T6 review fix for the N×M fan-out bug: each renderer owns
   * exactly one target and operates on it alone. SessionFrontend constructs
   * one ChannelRenderers bundle per workspace binding and dispatches each
   * event to every channel's renderer once.
   */
  target: RenderTarget;
}

/** Make a stable key for a RenderTarget so we can key maps by chat. */
export function targetKey(t: RenderTarget): string {
  return t.threadId ? `${t.channelType}:${t.chatId}:${t.threadId}` : `${t.channelType}:${t.chatId}`;
}

/** Factory: initial empty SessionRenderState. */
export function newSessionRenderState(init: {
  sessionId: string;
  shortAlias: string;
  workspaceId: string;
  workspaceName: string;
  targets: RenderTarget[];
}): SessionRenderState {
  return {
    sessionId: init.sessionId,
    shortAlias: init.shortAlias,
    workspaceId: init.workspaceId,
    workspaceName: init.workspaceName,
    targets: init.targets,
    pendingElicitationMsgIds: new Map(),
    lastInboundByTarget: new Map(),
  };
}
