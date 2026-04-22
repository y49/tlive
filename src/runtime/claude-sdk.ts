// src/runtime/claude-sdk.ts
//
// ClaudeSdkRuntime — wraps @anthropic-ai/claude-agent-sdk's query() in
// streaming-input mode. One long-lived query handles all turns in a session.
// Built on the pattern from bridge/src/providers/claude-live-session.ts,
// adapted to the AgentRuntime interface.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomBytes } from 'node:crypto';
import type {
  AgentRuntime, AgentRuntimeOptions, PermissionRequest, PermissionDecision,
} from './types.js';
import type { NotificationEvent, UsageStats } from './events.js';
import { ClaudeEventAdapter } from './claude-event-adapter.js';

export interface ClaudeSdkRuntimeDeps {
  /** Injectable for tests. Default: the real SDK's query(). */
  query?: typeof query;
}

export class ClaudeSdkRuntime implements AgentRuntime {
  readonly provider = 'claude' as const;

  private readonly query: typeof query;
  private readonly adapter = new ClaudeEventAdapter();
  private readonly eventCbs = new Set<(e: NotificationEvent) => void>();
  private readonly permCbs = new Set<(r: PermissionRequest) => void>();
  private readonly usageCbs = new Set<(u: UsageStats) => void>();

  private started = false;
  private closed = false;
  private messageQueue: string[] = [];
  private messageWaiter: ((msg: string | null) => void) | null = null;
  private queryIter: AsyncIterable<unknown> | null = null;
  private currentSessionId: string | null = null;

  constructor(deps: ClaudeSdkRuntimeDeps = {}) {
    this.query = deps.query ?? query;
  }

  async start(opts: AgentRuntimeOptions): Promise<void> {
    if (this.started) throw new Error('runtime already started');
    this.started = true;
    this.currentSessionId = opts.sessionId;
    if (opts.signal.aborted) { this.closed = true; return; }
    opts.signal.addEventListener('abort', () => { void this.stop(); }, { once: true });

    if (opts.initialPrompt) this.messageQueue.push(opts.initialPrompt);

    const self = this;
    async function* prompts() {
      while (true) {
        const msg = await self.nextMessage();
        if (msg === null) return;
        yield { type: 'user' as const, message: { role: 'user' as const, content: msg } };
      }
    }

    const iter = this.query({
      prompt: prompts(),
      options: {
        cwd: opts.workdir,
        model: opts.model,
        effort: opts.effort,
        resume: opts.sessionId || undefined,
        abortController: undefined,  // keep the SDK from auto-creating one
        signal: opts.signal,
        canUseTool: (toolName: string, toolInput: Record<string, unknown>, options?: { toolUseID?: string; suggestions?: unknown; signal?: AbortSignal }) =>
          this.handleCanUseTool(toolName, toolInput, options),
      },
    } as Parameters<typeof query>[0]);

    this.queryIter = iter as AsyncIterable<unknown>;
    // Kick off background consumer
    void this.consume();
  }

  async sendInput(text: string): Promise<void> {
    if (this.closed) throw new Error('runtime closed');
    if (this.messageWaiter) {
      const w = this.messageWaiter; this.messageWaiter = null; w(text);
    } else {
      this.messageQueue.push(text);
    }
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.messageWaiter) { const w = this.messageWaiter; this.messageWaiter = null; w(null); }
    // Attempt to interrupt in-flight SDK request if supported (blueprint pattern).
    const iter = this.queryIter as (AsyncIterable<unknown> & { interrupt?: () => Promise<void> | void }) | null;
    if (iter?.interrupt) {
      try { await iter.interrupt(); } catch { /* ignore */ }
    }
  }

  onEvent(cb: (e: NotificationEvent) => void) { this.eventCbs.add(cb); return () => this.eventCbs.delete(cb); }
  onPermissionRequest(cb: (r: PermissionRequest) => void) { this.permCbs.add(cb); return () => this.permCbs.delete(cb); }
  onUsage(cb: (u: UsageStats) => void) { this.usageCbs.add(cb); return () => this.usageCbs.delete(cb); }

  // ---- private ------------------------------------------------------------

  private nextMessage(): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    const queued = this.messageQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string | null>((resolve) => { this.messageWaiter = resolve; });
  }

  private async consume(): Promise<void> {
    if (!this.queryIter) return;
    let errored = false;
    try {
      for await (const msg of this.queryIter) {
        if (this.closed) break;
        const frame = this.adapter.adapt(msg as { type: string; [k: string]: unknown });
        for (const e of frame.events) this.fireEvent(e);
        if (frame.usage) this.fireUsage(frame.usage);
      }
    } catch (err) {
      errored = true;
      this.fireEvent({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (!this.closed && !errored) this.fireEvent({ kind: 'session_complete', summary: '' });
    }
  }

  private async handleCanUseTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    options?: { toolUseID?: string; suggestions?: unknown; signal?: AbortSignal },
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown }
    | { behavior: 'deny'; message: string }
  > {
    return new Promise((resolveSdk) => {
      // Short local id (8 hex chars) keeps the full permission id
      // `${sessionId}:${toolUseId}` under Telegram's 53-byte callback_data
      // limit after renderers prepend `perm:allow:` / `perm:deny:` prefixes.
      // The SDK's options.toolUseID is discarded — nothing downstream needs
      // correlation with the SDK's native tool_use id today.
      const toolUseId = randomBytes(4).toString('hex');
      const id = `${this.currentSessionId ?? 'unknown'}:${toolUseId}`;
      const request: PermissionRequest = {
        id, toolName, toolInput,
        resolve: (decision: PermissionDecision) => {
          if (decision === 'allow') {
            resolveSdk({ behavior: 'allow', updatedInput: toolInput });
          } else if (decision === 'allow_always') {
            const reply: { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown } = {
              behavior: 'allow', updatedInput: toolInput,
            };
            if (options?.suggestions !== undefined) reply.updatedPermissions = options.suggestions;
            resolveSdk(reply);
          } else {
            resolveSdk({ behavior: 'deny', message: 'Denied by user' });
          }
        },
      };
      for (const cb of this.permCbs) cb(request);
    });
  }

  private fireEvent(e: NotificationEvent): void { for (const cb of this.eventCbs) cb(e); }
  private fireUsage(u: UsageStats): void { for (const cb of this.usageCbs) cb(u); }
}
