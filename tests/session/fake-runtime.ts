// tests/session/fake-runtime.ts
//
// Minimal in-memory AgentRuntime stand-in for Session unit tests. Control-face
// methods throw UnsupportedByRuntimeError (the tests in this folder don't
// exercise them); runtime-level subscriptions + lifecycle are fully functional.

import type {
  AgentRuntime, AgentRuntimeOptions, AgentRuntimeStartResult,
  PermissionRequest, AskUserQuestionRequest, ElicitationRequest,
  SendInputOptions, PermissionMode, McpServerConfig, McpSetServersResult,
  McpServerStatus, ContextUsage, AccountInfo, SlashCommandInfo, ModelInfo,
  AgentInfo, RewindResult,
} from '../../src/runtime/types.js';
import type { NotificationEvent, UsageStats } from '../../src/runtime/events.js';
import { UnsupportedByRuntimeError } from '../../src/runtime/abstractions.js';

export class FakeRuntime implements AgentRuntime {
  readonly provider: 'claude' | 'codex';
  startCalls = 0;
  inputs: string[] = [];
  stopCalls = 0;
  started = false;
  private eventCbs = new Set<(e: NotificationEvent) => void>();
  private permCbs = new Set<(r: PermissionRequest) => void>();
  private askCbs = new Set<(r: AskUserQuestionRequest) => void>();
  private elicitCbs = new Set<(r: ElicitationRequest) => void>();
  private usageCbs = new Set<(u: UsageStats) => void>();

  constructor(provider: 'claude' | 'codex' = 'claude') { this.provider = provider; }

  async start(_opts: AgentRuntimeOptions): Promise<AgentRuntimeStartResult> {
    // Warm-pool reuse replays start() on a runtime that was never stopped
    // (LocalSession.detachRuntime preserves started=true). Real runtimes
    // handle this as "start a new session" against the same process; the
    // fake just allows re-entry and issues a fresh sdkSessionId.
    this.started = true;
    this.startCalls++;
    return { sdkSessionId: `fake-${this.startCalls}` };
  }
  async sendInput(text: string, _opts?: SendInputOptions): Promise<void> { this.inputs.push(text); }
  async stop(): Promise<void> { this.stopCalls++; this.started = false; }

  // Control face — tests don't exercise these; throw so misuse is loud.
  async interrupt(): Promise<void> { throw new UnsupportedByRuntimeError(this.provider, 'interrupt'); }
  async setModel(_model?: string): Promise<void> { throw new UnsupportedByRuntimeError(this.provider, 'setModel'); }
  async setPermissionMode(_mode: PermissionMode): Promise<void> { throw new UnsupportedByRuntimeError(this.provider, 'setPermissionMode'); }
  async applyPermissionRules(_rules: { allow?: string[]; deny?: string[] }): Promise<void> { throw new UnsupportedByRuntimeError(this.provider, 'applyPermissionRules'); }
  async stopTask(_id: string): Promise<void> { throw new UnsupportedByRuntimeError(this.provider, 'stopTask'); }
  async supportedCommands(): Promise<SlashCommandInfo[]> { return []; }
  async supportedModels(): Promise<ModelInfo[]> { return []; }
  async supportedAgents(): Promise<AgentInfo[]> { return []; }
  async mcpServerStatus(): Promise<McpServerStatus[]> { return []; }
  async getContextUsage(): Promise<ContextUsage> {
    return { totalTokens: 0, systemPromptTokens: 0, messagesTokens: 0, toolsTokens: 0, mcpToolsTokens: 0, memoryFilesTokens: 0, maxTokens: 200000 };
  }
  async accountInfo(): Promise<AccountInfo> { return {}; }
  async forkSession(_title?: string): Promise<{ sdkSessionId: string }> { throw new UnsupportedByRuntimeError(this.provider, 'forkSession'); }
  async renameSession(_title: string): Promise<void> { throw new UnsupportedByRuntimeError(this.provider, 'renameSession'); }
  async rewindFiles(_id: string, _opts?: { dryRun?: boolean }): Promise<RewindResult> { throw new UnsupportedByRuntimeError(this.provider, 'rewindFiles'); }
  async reloadPlugins(): Promise<void> { throw new UnsupportedByRuntimeError(this.provider, 'reloadPlugins'); }
  async setMcpServers(_s: Record<string, McpServerConfig>): Promise<McpSetServersResult> { throw new UnsupportedByRuntimeError(this.provider, 'setMcpServers'); }
  async reconnectMcpServer(_n: string): Promise<void> { throw new UnsupportedByRuntimeError(this.provider, 'reconnectMcpServer'); }
  async toggleMcpServer(_n: string, _e: boolean): Promise<void> { throw new UnsupportedByRuntimeError(this.provider, 'toggleMcpServer'); }

  onEvent(cb: (e: NotificationEvent) => void) { this.eventCbs.add(cb); return () => { this.eventCbs.delete(cb); }; }
  onPermissionRequest(cb: (r: PermissionRequest) => void) { this.permCbs.add(cb); return () => { this.permCbs.delete(cb); }; }
  onAskUserQuestion(cb: (r: AskUserQuestionRequest) => void) { this.askCbs.add(cb); return () => { this.askCbs.delete(cb); }; }
  onElicitation(cb: (r: ElicitationRequest) => void) { this.elicitCbs.add(cb); return () => { this.elicitCbs.delete(cb); }; }
  onUsage(cb: (u: UsageStats) => void) { this.usageCbs.add(cb); return () => { this.usageCbs.delete(cb); }; }

  // Test helpers
  emitEvent(e: NotificationEvent) { for (const cb of this.eventCbs) cb(e); }
  emitPermission(r: PermissionRequest) { for (const cb of this.permCbs) cb(r); }
  emitUsage(u: UsageStats) { for (const cb of this.usageCbs) cb(u); }
  emitAsk(r: AskUserQuestionRequest) { for (const cb of this.askCbs) cb(r); }
  emitElicitation(r: ElicitationRequest) { for (const cb of this.elicitCbs) cb(r); }
}
