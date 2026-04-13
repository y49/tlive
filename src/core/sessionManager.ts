import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PTYManager } from './ptyManager.js';
import { SessionScanner, type ToolUseEvent, type SessionEvent } from './sessionScanner.js';
import type { ProviderAdapter, NormalizedMessage } from '../sdk/providerAdapter.js';
import { ClaudePermissionHandler } from '../sdk/permissionHandler.js';
import { ThinkingTracker } from './thinkingTracker.js';
import type { TLiveConfig } from '../config.js';

/**
 * Minimal shape shared by Claude/Codex scanners: EventEmitter + lifecycle methods.
 * `start()` may be sync (returns void) or async (returns Promise<void>).
 */
export interface ScannerLike extends EventEmitter {
  start(): void | Promise<void>;
  stop(): void;
}

export type ScannerFactory = (args: {
  sessionId: string;
  workdir: string;
  sessionDir: string;
  proactiveNotifyDelay?: number;
  proactiveQuestionDelay?: number;
}) => ScannerLike;

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
  private scanner: ScannerLike;
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
    scannerFactory?: ScannerFactory;
  }) {
    super();
    this.sessionId = opts.sessionId ?? randomUUID();
    this.workdir = opts.workdir;
    this.adapter = opts.adapter;
    this.config = opts.config;
    this.pty = new PTYManager();
    this.thinkingTracker = new ThinkingTracker();
    this.thinkingTracker.on('change', (thinking: boolean) => this.emit('thinking', thinking));
    const sessionDir = opts.adapter.getSessionDir(opts.workdir);
    this.scanner = opts.scannerFactory
      ? opts.scannerFactory({
          sessionId: this.sessionId,
          workdir: this.workdir,
          sessionDir,
          proactiveNotifyDelay: opts.config.proactiveNotifyDelay,
          proactiveQuestionDelay: opts.config.proactiveQuestionDelay,
        })
      : new SessionScanner({
          sessionId: this.sessionId,
          sessionDir,
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

      // Dispatch thinking triggers via adapter. Claude implements the
      // content-block schema; Codex leaves this undefined (thinking stays
      // idle for Codex sessions — known v1.0 limitation).
      const triggers = this.adapter.extractThinkingEvents?.(event) ?? [];
      for (const t of triggers) {
        if (t.type === 'tool_use' && t.toolUseId) {
          this.thinkingTracker.trackToolUse(t.toolUseId);
        } else if (t.type === 'text') {
          this.thinkingTracker.trackAssistantMessage();
        } else if (t.type === 'tool_result' && t.toolUseId) {
          this.thinkingTracker.trackToolResult(t.toolUseId);
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

  async stop(): Promise<void> {
    this.thinkingTracker.reset();
    this.scanner.stop();
    this.sdkAbortController?.abort();
    this.permissionHandler?.cancelAll();
    if (this.pty.isRunning) await this.pty.kill();
    this.setState('idle');
  }
}
