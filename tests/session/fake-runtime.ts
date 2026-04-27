// tests/session/fake-runtime.ts
//
// Minimal in-memory AgentRuntime stand-in for Session unit tests. Implements
// the new prepare/attachSink contract; control-face methods throw
// UnsupportedByRuntimeError.

import type {
  AgentRuntime, AgentRuntimeOptions, AgentRuntimePrepareResult, EventSink,
  PermissionRequest, AskUserQuestionRequest, ElicitationRequest,
  SendInputOptions, PermissionMode, McpServerConfig, McpSetServersResult,
  McpServerStatus, ContextUsage, AccountInfo, SlashCommandInfo, ModelInfo,
  AgentInfo, RewindResult,
} from '../../src/runtime/types.js';
import type { NotificationEvent, UsageStats } from '../../src/runtime/events.js';
import { UnsupportedByRuntimeError } from '../../src/runtime/abstractions.js';

export class FakeRuntime implements AgentRuntime {
  readonly provider: 'claude' | 'codex';
  prepareCalls = 0;
  attachCalls = 0;
  inputs: string[] = [];
  stopCalls = 0;
  prepared = false;
  resumeRequestedFor: string | null = null;

  // Test helpers — pre-injected events fire at the appropriate phase.
  private preparePending: Array<
    | { kind: 'event'; e: NotificationEvent }
    | { kind: 'usage'; u: UsageStats }
    | { kind: 'perm'; r: PermissionRequest }
    | { kind: 'ask'; r: AskUserQuestionRequest }
    | { kind: 'elicit'; r: ElicitationRequest }
  > = [];
  private sink: EventSink | null = null;

  constructor(provider: 'claude' | 'codex' = 'claude') { this.provider = provider; }

  async prepare(opts: AgentRuntimeOptions): Promise<AgentRuntimePrepareResult> {
    if (this.prepared) throw new Error('runtime already prepared');
    this.prepared = true;
    this.prepareCalls++;
    this.resumeRequestedFor = opts.resumeSessionId ?? null;
    return { sdkSessionId: opts.resumeSessionId ?? `fake-${this.prepareCalls}` };
  }

  attachSink(sink: EventSink): void {
    if (!this.prepared) throw new Error('attachSink before prepare');
    if (this.sink) throw new Error('attachSink already called');
    this.sink = sink;
    this.attachCalls++;
    // Flush pending in injection order.
    for (const p of this.preparePending) {
      if (p.kind === 'event') sink.onEvent(p.e);
      else if (p.kind === 'usage') sink.onUsage(p.u);
      else if (p.kind === 'perm') sink.onPermissionRequest(p.r);
      else if (p.kind === 'ask') sink.onAskUserQuestion(p.r);
      else sink.onElicitation(p.r);
    }
    this.preparePending = [];
  }

  async sendInput(text: string, _opts?: SendInputOptions): Promise<void> { this.inputs.push(text); }
  async stop(): Promise<void> { this.stopCalls++; this.prepared = false; this.sink = null; }

  // Control face — tests don't exercise these.
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

  // Test helpers — fire after attachSink (sink path), or stash for prepare-window.
  emitEvent(e: NotificationEvent) { if (this.sink) this.sink.onEvent(e); else this.preparePending.push({ kind: 'event', e }); }
  emitUsage(u: UsageStats) { if (this.sink) this.sink.onUsage(u); else this.preparePending.push({ kind: 'usage', u }); }
  emitPermission(r: PermissionRequest) { if (this.sink) this.sink.onPermissionRequest(r); else this.preparePending.push({ kind: 'perm', r }); }
  emitAsk(r: AskUserQuestionRequest) { if (this.sink) this.sink.onAskUserQuestion(r); else this.preparePending.push({ kind: 'ask', r }); }
  emitElicitation(r: ElicitationRequest) { if (this.sink) this.sink.onElicitation(r); else this.preparePending.push({ kind: 'elicit', r }); }

  /** Test helper — inject before attachSink so sink flush picks it up. */
  injectInPrepareWindow(e: NotificationEvent): void { this.preparePending.push({ kind: 'event', e }); }

  // Backward-compat aliases for tests that still reference old names.
  // Remove these once all tests are updated in this same task.
  get started(): boolean { return this.prepared; }
  get startCalls(): number { return this.prepareCalls; }
}
