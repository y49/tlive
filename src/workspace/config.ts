// src/workspace/config.ts
//
// Workspace template — pure project config (spec 2026-05-08 §3.1). Runtime
// state (activeSessionId, costRollup, settings override) lives on
// ChatInstance per (channelType, chatId). Roles/admins removed entirely
// per chat-trust model.

import type { AgentProvider, Effort, McpServerConfig, PermissionMode, ThinkingLevel } from '../runtime/types.js';

export interface WorkspaceDefaults {
  provider: AgentProvider;
  model?: string;
  effort?: Effort;
  permissionMode: PermissionMode;
  thinking: ThinkingLevel;
  budgetUsd?: number;
  systemPromptAppend?: string;
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
  defaults: WorkspaceDefaults;
  budget: WorkspaceBudget;
  mcpServers: Record<string, McpServerConfig>;
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
  };
}
