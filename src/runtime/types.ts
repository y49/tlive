// src/runtime/types.ts
//
// AgentRuntime contract — full Claude Agent SDK + Codex app-server control
// surface. See docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md.

import type { NotificationEvent, UsageStats } from './events.js';

export type AgentProvider = 'claude' | 'codex';

export type PermissionMode =
  | 'default' | 'yolo' | 'safe-yolo' | 'plan'
  | 'acceptEdits' | 'dontAsk' | 'bypassPermissions';

export type Effort = 'low' | 'medium' | 'high' | 'max';

export type ThinkingLevel = 'collapsed' | 'expanded' | 'hidden';

export type PermissionDecision = 'allow' | 'deny' | 'allow_always';

export type PermissionCategory = 'exec' | 'file-edit' | 'generic' | 'elicitation';

export interface PermissionRequest {
  /** `${sdkSessionId}:${shortId}` — stable across reconnect. */
  id: string;
  category: PermissionCategory;
  toolName: string;
  toolInput: unknown;
  toolUseId?: string;
  diffPreview?: { from: string; to: string; added: number; removed: number; path?: string };
  risk?: 'low' | 'medium' | 'high';
  suggestions?: unknown;
  resolve: (decision: PermissionDecision) => void;
}

export interface AskUserQuestionRequest {
  id: string;
  prompt: string;
  options: string[];
  multiSelect?: boolean;
  resolve: (chosen: string[]) => void;
}

export interface ElicitationRequest {
  id: string;
  mcpServerName: string;
  mode: 'form' | 'url-auth' | 'confirm';
  schema?: Record<string, { type: string; required?: boolean; description?: string; default?: unknown }>;
  description?: string;
  url?: string;
  resolve: (result: { action: 'accept' | 'decline'; content?: Record<string, unknown> }) => void;
}

export interface SendInputOptions {
  model?: string;
  effort?: Effort;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: 'stdio' | 'sse' | 'http';
}

export interface AgentRuntimeOptions {
  workdir: string;
  /** When set, runtime resumes this SDK session id instead of creating a new
   *  one. Symmetry with create path; used by SessionManager.resumeLocal. */
  resumeSessionId?: string;
  initialPrompt?: string;
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' };
  systemPromptAppend?: string;
  includePartialMessages?: boolean;
  enableFileCheckpointing?: boolean;
  persistSession?: boolean;
  maxBudgetUsd?: number;
  mcpServers?: Record<string, McpServerConfig>;
  permissionPromptToolName?: string;
  promptSuggestions?: boolean;
  signal: AbortSignal;
}

/** Single sink that receives every signal a runtime emits. Replaces the
 *  five separate onX callbacks. Installed by `AgentRuntime.attachSink`. */
export interface EventSink {
  onEvent(e: NotificationEvent): void;
  onUsage(u: UsageStats): void;
  onPermissionRequest(r: PermissionRequest): void;
  onAskUserQuestion(r: AskUserQuestionRequest): void;
  onElicitation(r: ElicitationRequest): void;
}

export interface AgentRuntimePrepareResult {
  /** SDK-side session id. Same value the runtime later echoes through events. */
  sdkSessionId: string;
}

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error?: string;
}

export interface McpSetServersResult {
  added: string[];
  removed: string[];
  failed: Array<{ name: string; error: string }>;
}

export interface ContextUsage {
  totalTokens: number;
  systemPromptTokens: number;
  messagesTokens: number;
  toolsTokens: number;
  mcpToolsTokens: number;
  memoryFilesTokens: number;
  maxTokens: number;
}

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscription?: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  description?: string;
}

export interface AgentInfo {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: 'sdk-core' | 'plugin' | 'user' | 'tlive';
}

export interface RewindResult {
  canRewind: boolean;
  error?: string;
  /** Number of files touched by the rewind. */
  filesChanged: number;
  /** Lines added by the rewind (SDK semantics). */
  insertions: number;
  /** Lines removed by the rewind (SDK semantics). */
  deletions: number;
}

export interface AgentRuntime {
  readonly provider: AgentProvider;

  // Lifecycle (two-phase readiness gate; see spec §4.1).
  // prepare(): build query iter, capture sdkSessionId, stash any events the
  //            SDK fires before init resolves. Does NOT consume the iter.
  // attachSink(): install single sink, synchronously flush stash, then start
  //               background consumer. Throws if called twice or before prepare.
  prepare(opts: AgentRuntimeOptions): Promise<AgentRuntimePrepareResult>;
  attachSink(sink: EventSink): void;
  stop(): Promise<void>;

  // Input / control
  sendInput(text: string, opts?: SendInputOptions): Promise<void>;
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  applyPermissionRules(rules: { allow?: string[]; deny?: string[] }): Promise<void>;
  stopTask(taskId: string): Promise<void>;

  // Introspection
  supportedCommands(): Promise<SlashCommandInfo[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  getContextUsage(): Promise<ContextUsage>;
  accountInfo(): Promise<AccountInfo>;

  // Session utilities
  forkSession(title?: string): Promise<{ sdkSessionId: string }>;
  renameSession(title: string): Promise<void>;
  rewindFiles(userMessageId: string, opts?: { dryRun?: boolean }): Promise<RewindResult>;

  // Dynamic MCP
  reloadPlugins(): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  reconnectMcpServer(name: string): Promise<void>;
  toggleMcpServer(name: string, enabled: boolean): Promise<void>;
}
