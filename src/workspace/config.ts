// src/workspace/config.ts
//
// Workspace + WorkspaceDefaults shapes (spec §6.1). Plain data types — the
// behavioral WorkspaceManager lives in manager.ts, and bindings live in
// bindings.ts. Keeping the types isolated lets MCP tool schemas, IPC
// payloads, and renderer helpers import them without dragging in manager
// state.

import type { AgentProvider, Effort, McpServerConfig, PermissionMode, ThinkingLevel } from '../runtime/types.js';
import type { ChatBinding } from './bindings.js';

export type Role = 'admin' | 'operator' | 'observer';

export interface WorkspaceDefaults {
  provider: AgentProvider;
  model?: string;
  effort?: Effort;
  permissionMode: PermissionMode;
  thinking: ThinkingLevel;
  verbose: boolean;
  budgetUsd?: number;
  systemPromptAppend?: string;
  prewarmCache: boolean;
  threadPerSession: boolean;
}

export interface WorkspaceBudget {
  dailyUsd?: number;
  monthlyUsd?: number;
}

export interface Workspace {
  id: string;
  name: string;
  workdir: string;
  gitRemote?: string;
  activeSessionId: string | null;
  defaults: WorkspaceDefaults;
  budget: WorkspaceBudget;
  mcpServers: Record<string, McpServerConfig>;
  roles: Record<string, Role>;
  /** Default role assigned when a new user messages the workspace. */
  defaultRole: Role;
  bindings: ChatBinding[];
  createdAt: string;
}

/** Conventional IM-aware system prompt (spec §6.1). */
export const IM_AWARE_SYSTEM_PROMPT_APPEND = `You are being invoked from an IM bridge. Optimize your responses for mobile IM reading:
- Prefer terse Markdown. Attach long code (>40 lines), diffs (>100 lines), and reference
  documents as files via the Write tool — do not inline them in the conversation.
- When asking the user for input, use the AskUserQuestion tool so it renders as buttons
  rather than free-form prose.
- Users may type terse, typo-prone, or fragmentary messages from mobile keyboards;
  interpret charitably.
- Long bash output, file reads >300 lines, and search results should be summarized in
  conversation and the full output written to ./tlive-artifacts/<timestamp>-<name>.`;

export function defaultWorkspaceDefaults(provider: AgentProvider = 'claude'): WorkspaceDefaults {
  return {
    provider,
    permissionMode: 'default',
    thinking: 'collapsed',
    verbose: false,
    prewarmCache: false,
    threadPerSession: false,
  };
}
