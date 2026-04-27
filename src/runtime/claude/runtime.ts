// src/runtime/claude/runtime.ts
//
// ClaudeSdkRuntime — wraps @anthropic-ai/claude-agent-sdk's query() in
// streaming-input mode. One long-lived query handles all turns in a session.
// Composes the control face (control.ts), permission + elicitation handlers,
// options builder, and event adapter.

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentRuntime, AgentRuntimeOptions, AgentRuntimePrepareResult, EventSink,
  PermissionRequest, AskUserQuestionRequest, ElicitationRequest,
  SendInputOptions, PermissionMode,
  McpServerConfig,
} from '../types.js';
import type { NotificationEvent, UsageStats } from '../events.js';
import { ClaudeEventAdapter } from './event-adapter.js';
import { buildClaudeOptions } from './options-builder.js';
import { makeCanUseTool } from './permission-handler.js';
import { makeOnElicitation } from './elicitation-handler.js';
import { makeClaudeControlFace } from './control.js';
import { categorizeClaudeToolUse } from './categorize.js';
import { UnsupportedByRuntimeError } from '../abstractions.js';

type QueueEntry = { text: string; opts?: SendInputOptions };

export interface ClaudeSdkRuntimeDeps {
  /** Override the SDK `query` entrypoint. Test-only. */
  query?: typeof sdkQuery;
}

export class ClaudeSdkRuntime implements AgentRuntime {
  readonly provider = 'claude' as const;

  private readonly adapter = new ClaudeEventAdapter();

  // Stash for events fired before attachSink runs; flushed to sink in order.
  private stashEvents: NotificationEvent[] = [];
  private stashUsages: UsageStats[] = [];
  private stashPerm: PermissionRequest[] = [];
  private stashAsk: AskUserQuestionRequest[] = [];
  private stashElicit: ElicitationRequest[] = [];
  private sink: EventSink | null = null;

  private prepared = false;
  private closed = false;
  private messageQueue: QueueEntry[] = [];
  private messageWaiter: ((msg: QueueEntry | null) => void) | null = null;
  private queryIter: Query | null = null;
  private sdkSessionId: string | null = null;
  private control = makeClaudeControlFace(() => this.queryIter, () => this.sdkSessionId);
  private readonly queryFn: typeof sdkQuery;

  constructor(deps: ClaudeSdkRuntimeDeps = {}) {
    this.queryFn = deps.query ?? sdkQuery;
  }

  async prepare(opts: AgentRuntimeOptions): Promise<AgentRuntimePrepareResult> {
    if (this.prepared) throw new Error('runtime already prepared');
    this.prepared = true;
    if (opts.signal.aborted) { this.closed = true; throw new Error('aborted'); }
    opts.signal.addEventListener('abort', () => { void this.stop(); }, { once: true });

    if (opts.initialPrompt) this.messageQueue.push({ text: opts.initialPrompt });

    const canUseTool = makeCanUseTool({
      sdkSessionId: () => this.sdkSessionId,
      emitRequest: (r) => this.firePermissionRequest(r),
      categorize: categorizeClaudeToolUse,
    });
    const onElicitation = makeOnElicitation({
      sdkSessionId: () => this.sdkSessionId,
      emitRequest: (r) => this.fireElicitation(r),
    });

    const self = this;
    async function* prompts(): AsyncGenerator<{
      type: 'user';
      message: { role: 'user'; content: string };
      parent_tool_use_id: null;
      session_id: string;
    }> {
      while (true) {
        const entry = await self.nextMessage();
        if (entry === null) return;
        yield {
          type: 'user',
          message: { role: 'user', content: entry.text },
          parent_tool_use_id: null,
          session_id: self.sdkSessionId ?? '',
        };
      }
    }

    const options = buildClaudeOptions(opts, canUseTool, onElicitation);
    this.queryIter = this.queryFn({ prompt: prompts(), options });

    const iter = this.queryIter;
    let sessionId: string;
    try {
      if (opts.signal.aborted) throw new Error('aborted');
      const initMsg = await this.firstInitMessage(iter);
      sessionId = initMsg.session_id;
      this.sdkSessionId = sessionId;
    } catch (err) {
      try { this.queryIter?.close?.(); } catch { /* ignore */ }
      this.queryIter = null;
      this.prepared = false;
      throw err;
    }
    return { sdkSessionId: sessionId };
  }

  attachSink(sink: EventSink): void {
    if (!this.prepared) throw new Error('attachSink before prepare');
    if (this.sink) throw new Error('attachSink already called');
    this.sink = sink;
    // Synchronous flush of stashed signals (order: events, usages, perm, ask, elicit).
    for (const e of this.stashEvents) sink.onEvent(e);
    for (const u of this.stashUsages) sink.onUsage(u);
    for (const r of this.stashPerm) sink.onPermissionRequest(r);
    for (const a of this.stashAsk) sink.onAskUserQuestion(a);
    for (const e of this.stashElicit) sink.onElicitation(e);
    this.stashEvents = []; this.stashUsages = [];
    this.stashPerm = []; this.stashAsk = []; this.stashElicit = [];
    if (this.queryIter) void this.consume(this.queryIter);
  }

  async sendInput(text: string, opts?: SendInputOptions): Promise<void> {
    if (this.closed) throw new Error('runtime closed');
    const entry: QueueEntry = { text, opts };
    if (this.messageWaiter) {
      const w = this.messageWaiter; this.messageWaiter = null; w(entry);
    } else {
      this.messageQueue.push(entry);
    }
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.messageWaiter) { const w = this.messageWaiter; this.messageWaiter = null; w(null); }
    const q = this.queryIter;
    if (q) {
      try { await q.interrupt(); } catch { /* ignore */ }
      try { q.close(); } catch { /* ignore */ }
    }
  }

  // Control-face delegations (unchanged)
  interrupt() { return this.control.interrupt(); }
  setModel(model?: string) { return this.control.setModel(model); }
  setPermissionMode(mode: PermissionMode) { return this.control.setPermissionMode(mode); }
  applyPermissionRules(rules: { allow?: string[]; deny?: string[] }) { return this.control.applyPermissionRules(rules); }
  stopTask(id: string) { return this.control.stopTask(id); }
  supportedCommands() { return this.control.supportedCommands(); }
  supportedModels() { return this.control.supportedModels(); }
  supportedAgents() { return this.control.supportedAgents(); }
  mcpServerStatus() { return this.control.mcpServerStatus(); }
  getContextUsage() { return this.control.getContextUsage(); }
  accountInfo() { return this.control.accountInfo(); }
  forkSession(title?: string) { return this.control.forkSession(title); }
  renameSession(title: string) {
    if (!this.sdkSessionId) throw new UnsupportedByRuntimeError('claude', 'renameSession before session ready');
    return this.control.renameSession(this.sdkSessionId, title);
  }
  rewindFiles(userMessageId: string, opts?: { dryRun?: boolean }) { return this.control.rewindFiles(userMessageId, opts); }
  reloadPlugins() { return this.control.reloadPlugins(); }
  setMcpServers(s: Record<string, McpServerConfig>) { return this.control.setMcpServers(s); }
  reconnectMcpServer(n: string) { return this.control.reconnectMcpServer(n); }
  toggleMcpServer(n: string, e: boolean) { return this.control.toggleMcpServer(n, e); }

  // ---- private ------------------------------------------------------------

  private nextMessage(): Promise<QueueEntry | null> {
    if (this.closed) return Promise.resolve(null);
    const queued = this.messageQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => { this.messageWaiter = resolve; });
  }

  private async firstInitMessage(iter: Query): Promise<{ session_id: string }> {
    for await (const msg of iter as AsyncIterable<{ type: string; session_id?: string; [k: string]: unknown }>) {
      const frame = this.adapter.adapt(msg as { type: string });
      for (const e of frame.events) this.fireEvent(e);
      if (frame.usage) this.fireUsage(frame.usage);
      if (frame.askUserQuestion) this.fireAsk(frame.askUserQuestion);
      if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init' && typeof msg.session_id === 'string') {
        return { session_id: msg.session_id };
      }
    }
    throw new Error('query stream ended before init message');
  }

  private async consume(iter: Query): Promise<void> {
    let errored = false;
    try {
      for await (const msg of iter as AsyncIterable<unknown>) {
        if (this.closed) break;
        const frame = this.adapter.adapt(msg as { type: string });
        for (const e of frame.events) this.fireEvent(e);
        if (frame.usage) this.fireUsage(frame.usage);
        if (frame.askUserQuestion) this.fireAsk(frame.askUserQuestion);
      }
    } catch (err) {
      errored = true;
      this.fireEvent({
        kind: 'runtime_error',
        severity: 'fatal',
        code: 'claude_stream_error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (!this.closed && !errored) this.fireEvent({ kind: 'session_complete', reason: 'normal', summary: '' });
    }
  }

  private fireEvent(e: NotificationEvent): void {
    if (this.sink) this.sink.onEvent(e); else this.stashEvents.push(e);
  }
  private fireUsage(u: UsageStats): void {
    if (this.sink) this.sink.onUsage(u); else this.stashUsages.push(u);
  }
  private firePermissionRequest(r: PermissionRequest): void {
    if (this.sink) this.sink.onPermissionRequest(r); else this.stashPerm.push(r);
  }
  private fireAsk(r: AskUserQuestionRequest): void {
    if (this.sink) this.sink.onAskUserQuestion(r); else this.stashAsk.push(r);
  }
  private fireElicitation(r: ElicitationRequest): void {
    if (this.sink) this.sink.onElicitation(r); else this.stashElicit.push(r);
  }
}
