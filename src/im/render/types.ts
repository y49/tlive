// src/im/render/types.ts
//
// Shared renderer types. RenderContext holds the per-session state machine
// used by SessionFrontend to decide which anchor to edit, extend, or reset.
// Renderers mutate fields here as they send/edit platform messages.

import type { ChannelType } from '../../workspace/bindings.js';
import type { PlatformAdapter } from '../../platform/types.js';
import type { ChannelCapabilities } from '../capability-matrix.js';
import type { PermissionCategory } from '../../runtime/types.js';

// Inlined from deleted parallel-tools.ts (T10b).
export type ParallelToolStatus = 'running' | 'done_ok' | 'done_err';
export interface ParallelToolEntry {
  toolUseId: string;
  toolName: string;
  status: ParallelToolStatus;
  batchIndex?: number;
}

// Inlined from deleted subagent-nested.ts (T10b).
export interface SubagentEntry {
  agentId: string;
  description: string;
  latestSummary?: string;
  done: boolean;
  ok: boolean | null;
}

/** Destination (workspace binding) for a renderer. */
export interface RenderTarget {
  channelType: ChannelType;
  chatId: string;
  threadId?: string;
  /** primary receives buttons; mirrors get read-only echoes. */
  role: 'primary' | 'mirror';
}

/**
 * Tracked per-turn state inside a RenderContext. Reset on turn_start.
 */
export interface TurnRenderState {
  turnId: string;
  startedAtMs: number;
  /** Message id of the activity sticky, if posted. */
  activityMsgId?: string;
  /** Last text rendered — used to skip no-op edits. */
  activityLastText?: string;
  /** Unix-ms of the last activity edit (for throttling). */
  activityLastEditMs: number;
  /** Any deferred activity flush timer. */
  activityFlushTimer?: ReturnType<typeof setTimeout>;
  /** Message id of the streaming agent message, if posted. */
  agentMsgId?: string;
  /** Text accumulated so far. */
  agentAccText: string;
  /** Text that has been rendered to the message already. */
  agentRenderedText: string;
  /** Last time we flushed agent deltas. */
  agentLastFlushMs: number;
  /** Deferred agent flush timer. */
  agentFlushTimer?: ReturnType<typeof setTimeout>;
  /** Additional split-continuation message ids for long assistant text. */
  agentOverflowMsgIds: string[];
  /** Current parallel-tool batch entries, if any. */
  parallelTools: Map<string, ParallelToolEntry>;
  /** Active sub-agents, keyed by agentId. */
  subagents: Map<string, SubagentEntry>;
  /** Latest prompt suggestions for this turn (inline buttons on sticky). */
  promptSuggestions?: Array<{ id: string; text: string }>;
  /** Current tool name, if any. */
  currentTool?: string;
  /** Queue count at start of turn (for footer display). */
  queueCount: number;
  /** Whether this turn has produced any assistant text. */
  hasAssistantText: boolean;
  /**
   * Tools used during the turn, keyed by tool name → invocation count.
   * Populated from `tool_use_start` events; rendered in the assistant-message
   * footer on `turn_end` so the user sees `📦 Bash ×2 · Read ×1 (3 total)`.
   */
  toolUseCounts: Map<string, number>;
  /**
   * Last completed turn stats, captured from `turn_end`. Set on the SESSION
   * state too so the assistant-message renderer can stamp a footer line on
   * its final flush. Cleared when a new turn starts.
   */
  lastTurnStats?: {
    durationMs: number;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
  };
}

/**
 * Cross-turn state per session. Todo sticky and session header live here.
 */
export interface SessionRenderState {
  sessionId: string;
  shortAlias: string;
  workspaceId: string;
  workspaceName: string;
  targets: RenderTarget[];
  /** Session-header message id per-target (targetKey → msgId). */
  sessionHeaderMsgIds: Map<string, string>;
  /** Todo-sticky message id per-target. */
  todoMsgIds: Map<string, string>;
  /** Latest todo items (deduped). */
  todoItems: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; id?: string }>;
  /** pending permissions → msg ids per-target. */
  pendingPermissionMsgIds: Map<string, Map<string, string>>;
  /** pending elicitations → msg ids per-target. */
  pendingElicitationMsgIds: Map<string, Map<string, string>>;
  /** pending ask-user-question → msg ids per-target. */
  pendingAskMsgIds: Map<string, Map<string, string>>;
  /** Current turn state (one at a time in this session). */
  turn?: TurnRenderState;
  /** Mode badge (permission mode or effort shorthand). */
  modeLabel?: string;
  /** Current model id, for header. */
  model?: string;
  /** Latest total cost USD (for header). */
  costUsd: number;
  /** Cache warmUntilMs (for header). */
  cacheWarmUntilMs?: number | null;
  /** Reaction emoji set on most recent inbound message (for clear-on-turn-end). */
  lastInboundReactionMsg?: { chatId: string; messageId: string; emoji: string };
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

/** Category → template selector input. */
export interface PermissionTemplateInput {
  category: PermissionCategory;
  toolName: string;
  toolInput: unknown;
  diffPreview?: { from: string; to: string; added: number; removed: number; path?: string };
  risk?: 'low' | 'medium' | 'high';
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
    sessionHeaderMsgIds: new Map(),
    todoMsgIds: new Map(),
    todoItems: [],
    pendingPermissionMsgIds: new Map(),
    pendingElicitationMsgIds: new Map(),
    pendingAskMsgIds: new Map(),
    costUsd: 0,
    cacheWarmUntilMs: null,
    lastInboundByTarget: new Map(),
  };
}

/** Factory: initial empty TurnRenderState. */
export function newTurnRenderState(turnId: string, startedAtMs: number, queueCount: number): TurnRenderState {
  return {
    turnId,
    startedAtMs,
    activityLastEditMs: 0,
    agentAccText: '',
    agentRenderedText: '',
    agentLastFlushMs: 0,
    agentOverflowMsgIds: [],
    parallelTools: new Map(),
    subagents: new Map(),
    queueCount,
    hasAssistantText: false,
    toolUseCounts: new Map(),
  };
}
