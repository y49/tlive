// src/adapters/runtime/codex.ts

import type { RuntimeAdapter, RuntimeEvent, PermissionHandler } from '../../kernel/contracts/runtime-adapter.js';
import { spawnCodexAppServer, type CodexTransport } from './codex-transport.js';

export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly provider = 'codex';
  private transport: CodexTransport | null = null;
  private threadId: string | null = null;
  private readonly evQueue: RuntimeEvent[] = [];
  private evResolve: ((v: IteratorResult<RuntimeEvent>) => void) | null = null;
  private done = false;
  private permHandler: PermissionHandler | null = null;

  async start(opts: { workspaceDir: string; resumeProviderSessionId?: string }): Promise<{ providerSessionId: string }> {
    this.transport = await spawnCodexAppServer({});
    this.transport.onNotification((method, params) => this.handleNotification(method, params));
    if (opts.resumeProviderSessionId) {
      const r = await this.transport.request<{ threadId: string }>('thread/resume', { threadId: opts.resumeProviderSessionId, cwd: opts.workspaceDir });
      this.threadId = r.threadId;
    } else {
      const r = await this.transport.request<{ threadId: string }>('thread/start', { cwd: opts.workspaceDir });
      this.threadId = r.threadId;
    }
    this.pushEv({ kind: 'session_ready', providerSessionId: this.threadId });
    return { providerSessionId: this.threadId };
  }

  async sendUser(text: string): Promise<void> {
    if (!this.transport || !this.threadId) throw new Error('not started');
    await this.transport.request('thread/sendUserInput', { threadId: this.threadId, text });
  }

  async interrupt(): Promise<void> {
    if (!this.transport || !this.threadId) return;
    await this.transport.request('thread/interrupt', { threadId: this.threadId }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.done = true;
    await this.transport?.close();
    this.evResolve?.({ value: undefined as unknown as RuntimeEvent, done: true });
  }

  async *events(): AsyncIterable<RuntimeEvent> {
    while (!this.done || this.evQueue.length > 0) {
      if (this.evQueue.length > 0) { yield this.evQueue.shift()!; continue; }
      const next = await new Promise<IteratorResult<RuntimeEvent>>((resolve) => { this.evResolve = resolve; });
      if (next.done) return;
      yield next.value;
    }
  }

  installPermissionHandler(handler: PermissionHandler): void {
    this.permHandler = handler;
  }

  private pushEv(ev: RuntimeEvent) {
    if (this.evResolve) { const r = this.evResolve; this.evResolve = null; r({ value: ev, done: false }); }
    else this.evQueue.push(ev);
  }

  private handleNotification(method: string, params: unknown): void {
    // Codex app-server emits: thread.delta / thread.tool_call / thread.tool_result / thread.permission_request / thread.complete
    const p = params as { delta?: string; toolName?: string; input?: unknown; toolUseId?: string; output?: unknown; isError?: boolean; requestId?: string };
    switch (method) {
      case 'thread.delta':
        if (p.delta) this.pushEv({ kind: 'text_delta', delta: p.delta });
        return;
      case 'thread.tool_call':
        if (p.toolName && p.toolUseId) this.pushEv({ kind: 'tool_use_start', toolName: p.toolName, input: p.input, toolUseId: p.toolUseId });
        return;
      case 'thread.tool_result':
        if (p.toolUseId) this.pushEv({ kind: 'tool_use_result', toolUseId: p.toolUseId, output: p.output, isError: !!p.isError });
        return;
      case 'thread.permission_request':
        if (p.toolName && p.requestId) {
          this.pushEv({ kind: 'permission_request', toolName: p.toolName, input: p.input, requestId: p.requestId });
          // Also call out-of-band handler if installed (so daemon-embedded uses callback path)
          if (this.permHandler) {
            void this.permHandler({ toolName: p.toolName, input: p.input, requestId: p.requestId }).then(async (approved) => {
              await this.transport?.request('thread/permission_response', { requestId: p.requestId, approved });
            });
          }
        }
        return;
      case 'thread.complete':
        this.pushEv({ kind: 'turn_end' });
        return;
    }
  }
}
