// src/adapters/runtime/claude.ts
//
// Claude Code SDK wrapper. Implements RuntimeAdapter contract.
// Bug-for-bug compat with v0 NOT a goal; this is fresh impl.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  RuntimeAdapter, RuntimeEvent, PermissionHandler,
} from '../../kernel/contracts/runtime-adapter.js';

interface AdapterOpts {
  /** If set, passed to SDK as permissionPromptToolName (e.g. 'mcp__tlive__approve'). */
  permissionPromptToolName?: string;
}

export class ClaudeRuntimeAdapter implements RuntimeAdapter {
  readonly provider = 'claude';
  private sdkSessionId: string | null = null;
  private queryIter: AsyncGenerator<unknown, unknown, unknown> | null = null;
  private permissionHandler: PermissionHandler | null = null;
  private readonly evQueue: RuntimeEvent[] = [];
  private evResolve: ((v: IteratorResult<RuntimeEvent>) => void) | null = null;
  private done = false;

  constructor(private opts: AdapterOpts = {}) {}

  async start(opts: { workspaceDir: string; resumeProviderSessionId?: string; modelOpts?: Record<string, unknown> }): Promise<{ providerSessionId: string }> {
    const queryOpts: Record<string, unknown> = {
      cwd: opts.workspaceDir,
      ...(opts.resumeProviderSessionId ? { resume: opts.resumeProviderSessionId } : {}),
      ...(this.opts.permissionPromptToolName ? { permissionPromptToolName: this.opts.permissionPromptToolName } : {}),
      ...(opts.modelOpts ?? {}),
    };
    this.queryIter = query({ prompt: '', options: queryOpts }) as AsyncGenerator<unknown, unknown, unknown>;
    // Drive iter until we see session_id, then start streaming events.
    const ready = await this.consumeUntilSessionReady();
    this.sdkSessionId = ready;
    this.pushEv({ kind: 'session_ready', providerSessionId: ready });
    // Continue streaming in background.
    void this.consumeForever();
    return { providerSessionId: ready };
  }

  private async consumeUntilSessionReady(): Promise<string> {
    if (!this.queryIter) throw new Error('not started');
    while (true) {
      const r = await this.queryIter.next();
      if (r.done) throw new Error('SDK exited before session_ready');
      const frame = r.value as { type?: string; subtype?: string; session_id?: string };
      if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.session_id === 'string') {
        return frame.session_id;
      }
    }
  }

  private async consumeForever(): Promise<void> {
    if (!this.queryIter) return;
    try {
      while (!this.done) {
        const r = await this.queryIter.next();
        if (r.done) break;
        const ev = adaptSdkFrame(r.value);
        if (ev) this.pushEv(ev);
      }
    } catch (e) {
      this.pushEv({ kind: 'error', message: (e as Error).message, recoverable: false });
    } finally {
      this.done = true;
      this.evResolve?.({ value: undefined as unknown as RuntimeEvent, done: true });
    }
  }

  private pushEv(ev: RuntimeEvent): void {
    if (this.evResolve) {
      const r = this.evResolve;
      this.evResolve = null;
      r({ value: ev, done: false });
    } else {
      this.evQueue.push(ev);
    }
  }

  async sendUser(text: string): Promise<void> {
    // Claude SDK: continue conversation by calling query() again with resume.
    // This adapter assumes sendUser is called between turns. Real impl may
    // need richer streaming-input support; deferred to adapter v1.1.
    if (!this.sdkSessionId) throw new Error('session not ready');
    this.queryIter = query({
      prompt: text,
      options: { resume: this.sdkSessionId, ...(this.opts.permissionPromptToolName ? { permissionPromptToolName: this.opts.permissionPromptToolName } : {}) },
    }) as AsyncGenerator<unknown, unknown, unknown>;
    void this.consumeForever();
  }

  async interrupt(): Promise<void> {
    if (this.queryIter && typeof (this.queryIter as { return?: unknown }).return === 'function') {
      await (this.queryIter as { return: (v: unknown) => Promise<unknown> }).return(undefined);
    }
  }

  async stop(): Promise<void> {
    this.done = true;
    await this.interrupt();
  }

  async *events(): AsyncIterable<RuntimeEvent> {
    while (!this.done || this.evQueue.length > 0) {
      if (this.evQueue.length > 0) {
        yield this.evQueue.shift()!;
        continue;
      }
      const next = await new Promise<IteratorResult<RuntimeEvent>>((resolve) => {
        this.evResolve = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }

  installPermissionHandler(handler: PermissionHandler): void {
    this.permissionHandler = handler;
    // TODO Phase 5: wire this into SDK's canUseTool callback when SDK supports it.
    // For now, permission goes through MCP tool path (--permission-prompt-tool).
    void this.permissionHandler;
  }
}

function adaptSdkFrame(frame: unknown): RuntimeEvent | null {
  const f = frame as { type?: string; subtype?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
  if (f.type === 'assistant' && Array.isArray(f.message?.content)) {
    for (const c of f.message!.content!) {
      if (c.type === 'text' && typeof c.text === 'string') {
        return { kind: 'text_delta', delta: c.text };
      }
    }
  }
  if (f.type === 'result') {
    return { kind: 'turn_end' };
  }
  return null;
}
