// src/runtime/claude/runtime.ts
//
// ClaudeSdkRuntime — wraps @anthropic-ai/claude-agent-sdk's query() in
// streaming-input mode. One long-lived query handles all turns in a session.
// Composes the control face (control.ts), permission + elicitation handlers,
// options builder, and event adapter.

import { appendFileSync } from 'node:fs';
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

/**
 * ClaudeSdkRuntime wraps the Claude Agent SDK's query() in streaming-input mode.
 *
 * Debug capture: setting `TL_DEBUG_SDK_FRAMES=/path/to/file.jsonl` causes every
 * raw SDK frame to be appended as one JSON line. Used to capture fixtures for
 * tests/runtime/claude/fixtures/ (Spec X §5.7 step 1). No effect when unset.
 */
export class ClaudeSdkRuntime implements AgentRuntime {
  readonly provider = 'claude' as const;

  private readonly debugFramesPath: string | null = process.env.TL_DEBUG_SDK_FRAMES ?? null;
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
  /**
   * Long-lived async iterator obtained ONCE from queryIter. We hold it
   * across prepare→attachSink so neither stage's loop closes it.
   *
   * Why this exists: `for await (const msg of iter) { ... return X; }`
   * triggers ECMA-262 §13.7.5.13 iterator-return-on-completion. The Claude
   * Agent SDK's Query is a single-pass async iterable; once for-await
   * returns/breaks/throws, the iterator's `.return()` runs and the SDK
   * subprocess stream is closed. That left the post-init assistant /
   * tool_use frames stranded in the SDK and consume() got nothing — the
   * actual root cause behind B4 (no Claude reply visible in IM).
   *
   * Fix: use manual `iterator.next()` calls. firstInitMessage drains until
   * init then returns; consume() picks up where it left off on the SAME
   * iterator. No for-await, no auto-close.
   */
  private sdkIterator: AsyncIterator<unknown> | null = null;
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

    // Get the iterator ONCE and hold it across prepare→attachSink. See the
    // sdkIterator field comment for why we can't use for-await here.
    this.sdkIterator = (this.queryIter as AsyncIterable<unknown>)[Symbol.asyncIterator]();

    let sessionId: string;
    try {
      if (opts.signal.aborted) throw new Error('aborted');
      const initMsg = await this.firstInitMessage();
      sessionId = initMsg.session_id;
      this.sdkSessionId = sessionId;
    } catch (err) {
      try { this.queryIter?.close?.(); } catch { /* ignore */ }
      this.queryIter = null;
      this.sdkIterator = null;
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
    if (this.sdkIterator) void this.consume();
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

  private logRawFrame(msg: unknown): void {
    if (this.debugFramesPath) {
      try { appendFileSync(this.debugFramesPath, JSON.stringify(msg) + '\n'); }
      catch { /* debug-only, never fatal */ }
    }
  }

  private nextMessage(): Promise<QueueEntry | null> {
    if (this.closed) return Promise.resolve(null);
    const queued = this.messageQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => { this.messageWaiter = resolve; });
  }

  /**
   * Drain the SDK iter until system/init arrives, returning its session_id.
   * Uses manual iterator.next() (not for-await) so the iterator stays open
   * for consume() to continue from. See sdkIterator field comment for the
   * underlying ECMA-262 §13.7.5.13 hazard this avoids.
   */
  private async firstInitMessage(): Promise<{ session_id: string }> {
    const it = this.sdkIterator;
    if (!it) throw new Error('firstInitMessage called before sdkIterator initialized');
    while (true) {
      const r = await it.next();
      if (r.done) throw new Error('query stream ended before init message');
      const msg = r.value as { type: string; session_id?: string; subtype?: string; [k: string]: unknown };
      this.logRawFrame(msg);
      const frame = this.adapter.adapt(msg as { type: string });
      for (const e of frame.events) this.fireEvent(e);
      if (frame.usage) this.fireUsage(frame.usage);
      if (frame.askUserQuestion) this.fireAsk(frame.askUserQuestion);
      if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
        return { session_id: msg.session_id };
      }
    }
  }

  /**
   * Continue iterating the SDK stream from where firstInitMessage left off.
   * Manual iterator.next() (not for-await) — see firstInitMessage / sdkIterator
   * for the rationale.
   *
   * Emits stderr breadcrumbs (component-prefixed) at each lifecycle boundary
   * so the daemon log surfaces consume's progress without a logger reference:
   *   [claude/consume] start
   *   [claude/consume] frame N type=<msg.type>   (first frame only)
   *   [claude/consume] done frames=<N>
   *   [claude/consume] error <msg>
   * The runtime is constructed before the daemon's logger is wired through;
   * stderr is the lowest-friction trace we can emit. `daemon.log` captures it.
   */
  private async consume(): Promise<void> {
    const it = this.sdkIterator;
    if (!it) return;
    process.stderr.write(`[claude/consume] start sdkSessionId=${this.sdkSessionId ?? 'unknown'}\n`);
    let errored = false;
    let frames = 0;
    try {
      while (!this.closed) {
        const r = await it.next();
        if (r.done) break;
        const msg = r.value;
        frames++;
        if (frames === 1) {
          const t = (msg as { type?: unknown })?.type;
          process.stderr.write(`[claude/consume] first frame type=${String(t)}\n`);
        }
        this.logRawFrame(msg);
        const frame = this.adapter.adapt(msg as { type: string });
        for (const e of frame.events) this.fireEvent(e);
        if (frame.usage) this.fireUsage(frame.usage);
        if (frame.askUserQuestion) this.fireAsk(frame.askUserQuestion);
      }
    } catch (err) {
      errored = true;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[claude/consume] error frames=${frames} msg=${msg}\n`);
      this.fireEvent({
        kind: 'runtime_error',
        severity: 'fatal',
        code: 'claude_stream_error',
        message: msg,
      });
    } finally {
      if (!errored) process.stderr.write(`[claude/consume] done frames=${frames} closed=${this.closed}\n`);
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
