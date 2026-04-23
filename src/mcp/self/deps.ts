// src/mcp/self/deps.ts
//
// Dependency bundle every tlive-self MCP tool factory receives. Keeps the
// server's wiring testable: production code wires real SessionManager /
// brokers / AttachmentStore; tests inject fakes/spies.
//
// Spec: docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md §9.

import type { SessionManager } from '../../session/manager.js';
import type { WorkspaceManager } from '../../workspace/manager.js';
import type { PermissionBroker } from '../../permission/broker.js';
import type { AskUserQuestionBroker } from '../../permission/ask-broker.js';
import type { ElicitationBroker } from '../../permission/elicitation-broker.js';
import type { AttachmentStore } from '../../attachment/store.js';
import type { PolicyStore } from '../../permission/policy-store.js';
import type { CostRollupStore } from '../../cost/rollups.js';

/** Factory so each workspace gets its own PolicyStore lazily. */
export type PolicyStoreFactory = (workspaceId: string) => PolicyStore;

export interface UserInfo {
  /** Opaque operator identity — T7 plumbs real IM user ids. */
  id: string;
  displayName?: string;
}

export interface SignalBus {
  /** Long-poll helper used by `tlive.await_signal` / `tlive.await_user_input`. */
  await(
    sessionId: string,
    kind: 'interrupt' | 'user_input' | 'any',
    timeoutMs: number,
  ): Promise<{ kind: string; payload?: unknown } | null>;
  /** Emit a named signal to a single session — IM command router drives this. */
  emit(sessionId: string, kind: 'interrupt' | 'user_input', payload?: unknown): void;
}

export interface IMNotifier {
  /** Push a text status to the user's IM. T6 wires the real renderer. */
  notify(
    sessionId: string,
    text: string,
    opts?: { urgency?: 'low' | 'normal' | 'high'; summary?: string; when?: 'session_end' | 'now' | 'next_idle' },
  ): Promise<void> | void;
}

export interface McpToolDeps {
  sessions: SessionManager;
  workspaces: WorkspaceManager;
  permissionBroker: PermissionBroker;
  askBroker: AskUserQuestionBroker;
  elicitationBroker?: ElicitationBroker;
  attachments: AttachmentStore;
  policyStoreFor: PolicyStoreFactory;
  rollups?: CostRollupStore;
  signals: SignalBus;
  notifier: IMNotifier;
  /** Who the caller is — defaults to "mcp-client" when unknown. */
  user: () => UserInfo;
  /** Root for cron/registry/pipelines/memory files. Defaults to ~/.tlive. */
  dataDir?: string;
}

/**
 * Per-call context the server attaches to each tool invocation. `sessionId`
 * is the sdkSessionId of the RemoteSession auto-created at `initialize`
 * handshake; `workspaceId` is derived from the calling agent's cwd.
 */
export interface ToolCallCtx {
  sessionId: string;
  workspaceId: string;
  /** Short-alias for UI/log copy. */
  shortAlias?: string;
}

export interface McpToolContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpToolContent[];
  isError?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export type McpToolHandler = (args: Record<string, unknown>, ctx: ToolCallCtx) => Promise<McpToolResult>;

export interface McpTool {
  definition: McpToolDefinition;
  handler: McpToolHandler;
}
