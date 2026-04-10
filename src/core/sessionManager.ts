import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PTYManager } from './ptyManager.js';
import { SessionScanner, type ToolUseEvent, type SessionEvent } from './sessionScanner.js';
import type { ProviderAdapter, NormalizedMessage } from '../sdk/providerAdapter.js';
import { ClaudePermissionHandler } from '../sdk/permissionHandler.js';
import { ThinkingTracker } from './thinkingTracker.js';
import type { TLiveConfig } from '../config.js';

export type SessionState = 'idle' | 'pty_active' | 'sdk_active';

export interface SessionInfo {
  sessionId: string;
  workdir: string;
  state: SessionState;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
}

export class SessionManager extends EventEmitter {
  private _state: SessionState = 'idle';
  private sessionId: string;
  private workdir: string;
  private pty: PTYManager;
  private scanner: SessionScanner;
  private adapter: ProviderAdapter;
  private config: TLiveConfig;
  private permissionHandler: ClaudePermissionHandler | null = null;
  private sdkAbortController: AbortController | null = null;
  private thinkingTracker: ThinkingTracker;
  private _createdAt = Date.now();
  private _lastActivityAt = Date.now();
  private _messageCount = 0;

  constructor(opts: {
    sessionId?: string;
    workdir: string;
    adapter: ProviderAdapter;
    config: TLiveConfig;
  }) {
    super();
    this.sessionId = opts.sessionId ?? randomUUID();
    this.workdir = opts.workdir;
    this.adapter = opts.adapter;
    this.config = opts.config;
    this.pty = new PTYManager();
    this.thinkingTracker = new ThinkingTracker();
    this.thinkingTracker.on('change', (thinking: boolean) => this.emit('thinking', thinking));
    this.scanner = new SessionScanner({
      sessionId: this.sessionId,
      sessionDir: opts.adapter.getSessionDir(opts.workdir),
      workdir: this.workdir,
      proactiveNotifyDelay: opts.config.proactiveNotifyDelay,
      proactiveQuestionDelay: opts.config.proactiveQuestionDelay,
    });
    this.setupListeners();
  }

  get state(): SessionState { return this._state; }

  get info(): SessionInfo {
    return {
      sessionId: this.sessionId, workdir: this.workdir, state: this._state,
      createdAt: this._createdAt, lastActivityAt: this._lastActivityAt,
      messageCount: this._messageCount,
    };
  }

  private setState(state: SessionState): void {
    this._state = state;
    this.emit('stateChange', state, this.info);
  }

  private setupListeners(): void {
    this.pty.on('data', (data: string) => this.emit('ptyData', data));
    this.pty.on('exit', () => {
      if (this._state === 'pty_active') {
        this.setState('idle');
        this.emit('sessionComplete', this.info);
      }
    });
    this.scanner.on('event', (event: SessionEvent) => {
      this._lastActivityAt = Date.now();
      this._messageCount++;
      this.emit('scannerEvent', event);

      // Track thinking state from content blocks
      const blocks = this.getContentBlocks(event.message);
      if (event.type === 'assistant') {
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            this.thinkingTracker.trackToolUse(block.id as string);
          } else if (block.type === 'text') {
            this.thinkingTracker.trackAssistantMessage();
          }
        }
      }
      if (event.type === 'user') {
        for (const block of blocks) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            this.thinkingTracker.trackToolResult(block.tool_use_id as string);
          }
        }
      }
    });
    this.scanner.on('permission_needed', (toolUse: ToolUseEvent) => this.emit('permissionNeeded', toolUse));
    this.scanner.on('permission_resolved', (toolUseId: string) => this.emit('permissionResolved', toolUseId));
    this.scanner.on('usage', (usage: Record<string, unknown>) => this.emit('usage', usage));
    this.scanner.on('model', (model: string) => this.emit('model', model));
  }

  async startPTY(): Promise<void> {
    if (this._state !== 'idle') throw new Error(`Cannot start PTY from state: ${this._state}`);
    const executable = await this.adapter.resolveExecutable();
    const args = this.adapter.spawnArgs({ sessionId: this.sessionId, cwd: this.workdir });
    this.pty.spawn({ command: executable, args, cwd: this.workdir });
    this.scanner.start();
    this.setState('pty_active');
  }

  async handoffToSDK(opts?: {
    onPermissionRequest?: (id: string, toolName: string, input: unknown) => void;
    onAskUserQuestion?: (question: string, resolve: (answer: string) => void) => void;
  }): Promise<void> {
    if (this._state !== 'pty_active') throw new Error(`Cannot handoff from state: ${this._state}`);
    await this.pty.kill();
    this.setState('sdk_active');
    this.sdkAbortController = new AbortController();
    this.permissionHandler = new ClaudePermissionHandler({
      timeout: this.config.permissionTimeout,
      onPermissionRequest: opts?.onPermissionRequest,
    });
    try {
      const stream = this.adapter.startRemote({
        sessionId: this.sessionId, cwd: this.workdir, resume: true,
        permissionHandler: this.permissionHandler,
        signal: this.sdkAbortController.signal,
        onAskUserQuestion: opts?.onAskUserQuestion,
      });
      for await (const msg of stream) {
        this.emit('sdkMessage', msg);
        if (msg.kind === 'complete') break;
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') this.emit('error', err as Error);
    }
    this.permissionHandler = null;
    this.sdkAbortController = null;
    if ((this._state as SessionState) === 'sdk_active') await this.restorePTY();
  }

  async restorePTY(): Promise<void> {
    const executable = await this.adapter.resolveExecutable();
    const args = [...this.adapter.getResumeArgs(this.sessionId)];
    this.pty.spawn({ command: executable, args, cwd: this.workdir });
    this.setState('pty_active');
  }

  async takebackToTerminal(): Promise<void> {
    if (this._state !== 'sdk_active') return;
    this.sdkAbortController?.abort();
    this.permissionHandler?.cancelAll();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await this.restorePTY();
  }

  resolvePermission(id: string, decision: 'allow' | 'deny' | 'allow_always'): boolean {
    return this.permissionHandler?.resolve(id, decision) ?? false;
  }

  writeToPTY(data: string): void { this.pty.write(data); }
  resizePTY(cols: number, rows: number): void { this.pty.resize(cols, rows); }

  /**
   * Extract content blocks from a message.
   * Claude .jsonl format: { message: { role: "assistant", content: [...] } }
   */
  private getContentBlocks(message: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(message)) return message;
    if (message && typeof message === 'object') {
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) return content;
    }
    return [];
  }

  async stop(): Promise<void> {
    this.thinkingTracker.reset();
    this.scanner.stop();
    this.sdkAbortController?.abort();
    this.permissionHandler?.cancelAll();
    if (this.pty.isRunning) await this.pty.kill();
    this.setState('idle');
  }
}
