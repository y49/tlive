// src/runtime/claude/runtime.ts
//
// ClaudeSdkRuntime — wraps @anthropic-ai/claude-agent-sdk's query() in
// streaming-input mode. One long-lived query handles all turns in a session.
// Composes the control face (control.ts), permission + elicitation handlers,
// options builder, and event adapter.

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentRuntime, AgentRuntimeOptions, AgentRuntimeStartResult,
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

export class ClaudeSdkRuntime implements AgentRuntime {
  readonly provider = 'claude' as const;

  private readonly adapter = new ClaudeEventAdapter();
  private readonly eventCbs = new Set<(e: NotificationEvent) => void>();
  private readonly permCbs = new Set<(r: PermissionRequest) => void>();
  private readonly askCbs = new Set<(r: AskUserQuestionRequest) => void>();
  private readonly elicitCbs = new Set<(r: ElicitationRequest) => void>();
  private readonly usageCbs = new Set<(u: UsageStats) => void>();

  private started = false;
  private closed = false;
  private messageQueue: QueueEntry[] = [];
  private messageWaiter: ((msg: QueueEntry | null) => void) | null = null;
  private queryIter: Query | null = null;
  private sdkSessionId: string | null = null;
  private control = makeClaudeControlFace(() => this.queryIter, () => this.sdkSessionId);

  async start(opts: AgentRuntimeOptions): Promise<AgentRuntimeStartResult> {
    if (this.started) throw new Error('runtime already started');
    this.started = true;
    if (opts.signal.aborted) { this.closed = true; throw new Error('aborted'); }
    opts.signal.addEventListener('abort', () => { void this.stop(); }, { once: true });

    if (opts.initialPrompt) this.messageQueue.push({ text: opts.initialPrompt });

    const canUseTool = makeCanUseTool({
      sdkSessionId: () => this.sdkSessionId,
      emitRequest: (r) => { for (const cb of this.permCbs) cb(r); },
      categorize: categorizeClaudeToolUse,
    });
    const onElicitation = makeOnElicitation({
      sdkSessionId: () => this.sdkSessionId,
      emitRequest: (r) => { for (const cb of this.elicitCbs) cb(r); },
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
    this.queryIter = sdkQuery({ prompt: prompts(), options });

    // Wait for init event to capture sdkSessionId, then spawn background consumer.
    const iter = this.queryIter;
    const initMsg = await this.firstInitMessage(iter);
    this.sdkSessionId = initMsg.session_id;
    void this.consume(iter);
    return { sdkSessionId: this.sdkSessionId };
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

  // Control-face delegations
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

  // Event subscriptions
  onEvent(cb: (e: NotificationEvent) => void) { this.eventCbs.add(cb); return () => { this.eventCbs.delete(cb); }; }
  onPermissionRequest(cb: (r: PermissionRequest) => void) { this.permCbs.add(cb); return () => { this.permCbs.delete(cb); }; }
  onAskUserQuestion(cb: (r: AskUserQuestionRequest) => void) { this.askCbs.add(cb); return () => { this.askCbs.delete(cb); }; }
  onElicitation(cb: (r: ElicitationRequest) => void) { this.elicitCbs.add(cb); return () => { this.elicitCbs.delete(cb); }; }
  onUsage(cb: (u: UsageStats) => void) { this.usageCbs.add(cb); return () => { this.usageCbs.delete(cb); }; }

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
        if (frame.askUserQuestion) for (const cb of this.askCbs) cb(frame.askUserQuestion);
      }
    } catch (err) {
      errored = true;
      this.fireEvent({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (!this.closed && !errored) this.fireEvent({ kind: 'session_complete', summary: '' });
    }
  }

  private fireEvent(e: NotificationEvent): void { for (const cb of this.eventCbs) cb(e); }
  private fireUsage(u: UsageStats): void { for (const cb of this.usageCbs) cb(u); }
}
