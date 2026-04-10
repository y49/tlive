import { CostTracker, type UsageStats } from './cost-tracker.js';
import type { ProgressSnapshot, PermissionState } from '../renderers/types.js';

export interface MessageRendererOptions {
  platformLimit: number;
  throttleMs?: number;
  flushCallback: (
    snapshot: ProgressSnapshot,
    isEdit: boolean,
  ) => Promise<string | void>;
  /** Called when permission waits >60s without response */
  onPermissionTimeout?: (toolName: string, input: string, buttons: Array<{ label: string; callbackData: string; style: string }>) => void;
}

/** Tools silently ignored — never counted or displayed */
const HIDDEN_TOOLS = new Set([
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'TaskStop', 'TaskOutput', 'ToolSearch', 'TodoRead',
]);

export class MessageRenderer {
  private toolCounts = new Map<string, number>();
  private totalTools = 0;
  private responseText = '';
  private completed = false;
  private costLine?: string;
  private errorMessage?: string;
  private permissionQueue: PermissionState[] = [];
  private todoItems: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> = [];

  private _messageId?: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private permissionTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private elapsedSeconds = 0;
  private platformLimit: number;
  private throttleMs: number;
  private flushCallback: MessageRendererOptions['flushCallback'];
  private onPermissionTimeout?: MessageRendererOptions['onPermissionTimeout'];
  private flushing = false;
  private pendingFlush = false;

  get messageId(): string | undefined {
    return this._messageId;
  }

  constructor(options: MessageRendererOptions) {
    this.platformLimit = options.platformLimit;
    this.throttleMs = options.throttleMs ?? 300;
    this.flushCallback = options.flushCallback;
    this.onPermissionTimeout = options.onPermissionTimeout;
  }

  onToolStart(name: string): void {
    if (HIDDEN_TOOLS.has(name)) return;
    const current = this.toolCounts.get(name) ?? 0;
    this.toolCounts.set(name, current + 1);
    this.totalTools++;

    // Start elapsed timer on first tool
    if (!this.elapsedTimer) {
      this.elapsedTimer = setInterval(() => {
        this.elapsedSeconds++;
        this.scheduleFlush();
      }, 1000);
    }

    this.scheduleFlush();
  }

  onToolComplete(_toolUseId: string): void {
    // No-op — counter already incremented on start
  }

  onPermissionNeeded(
    toolName: string,
    input: string,
    permId: string,
    buttons: Array<{ label: string; callbackData: string; style: string }>,
  ): void {
    this.permissionQueue.push({ toolName, input, permId, buttons });
    // Only start timeout for the first permission (the one being displayed)
    if (this.permissionQueue.length === 1) {
      this.startPermissionTimeout();
    }
    this.scheduleFlush();
  }

  onPermissionResolved(permId?: string): void {
    // Remove the resolved permission from queue
    if (permId) {
      const idx = this.permissionQueue.findIndex(p => p.permId === permId);
      if (idx !== -1) this.permissionQueue.splice(idx, 1);
    } else {
      // No permId: remove the head (currently displayed one)
      this.permissionQueue.shift();
    }
    // Restart timeout for next permission in queue
    this.clearPermissionTimeout();
    if (this.permissionQueue.length > 0) {
      this.startPermissionTimeout();
    }
    this.scheduleFlush();
  }

  private startPermissionTimeout(): void {
    this.clearPermissionTimeout();
    if (this.onPermissionTimeout && this.permissionQueue.length > 0) {
      this.permissionTimeoutTimer = setTimeout(() => {
        const head = this.permissionQueue[0];
        if (head) {
          this.onPermissionTimeout!(head.toolName, head.input, head.buttons);
        }
      }, 60_000);
    }
  }

  onTodoUpdate(todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>): void {
    this.todoItems = todos;
    this.scheduleFlush();
  }

  onTextDelta(text: string): void {
    this.responseText += text;
    this.scheduleFlush();
  }

  onComplete(stats: UsageStats): void {
    this.completed = true;
    this.costLine = CostTracker.format(stats);
    this.stopTimers();
    this.doFlush(this.snapshot());
  }

  onError(error: string): void {
    this.errorMessage = error;
    this.stopTimers();
    this.doFlush(this.snapshot());
  }

  snapshot(): ProgressSnapshot {
    let phase: ProgressSnapshot['phase'];
    if (this.completed) phase = 'completed';
    else if (this.errorMessage) phase = 'error';
    else if (this.permissionQueue.length > 0) phase = 'permission';
    else if (this.totalTools > 0 || this.responseText) phase = 'executing';
    else phase = 'starting';

    return {
      phase,
      toolCounts: new Map(this.toolCounts),
      totalTools: this.totalTools,
      elapsedSeconds: this.elapsedSeconds,
      responseText: this.responseText,
      permissionQueue: [...this.permissionQueue],
      todoItems: [...this.todoItems],
      costLine: this.costLine,
      errorMessage: this.errorMessage,
    };
  }

  getResponseText(): string {
    return this.responseText;
  }

  dispose(): void {
    this.stopTimers();
  }

  // --- Internal ---

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const snap = this.snapshot();
      this.doFlush(snap);
    }, this.throttleMs);
  }

  private stopTimers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    this.clearPermissionTimeout();
  }

  private clearPermissionTimeout(): void {
    if (this.permissionTimeoutTimer) {
      clearTimeout(this.permissionTimeoutTimer);
      this.permissionTimeoutTimer = null;
    }
  }

  private async doFlush(snap: ProgressSnapshot): Promise<void> {
    // Skip if no meaningful content yet
    if (snap.phase === 'starting' && snap.totalTools === 0 && !snap.responseText) return;

    if (this.flushing) {
      this.pendingFlush = true;
      return;
    }
    this.flushing = true;
    try {
      const isEdit = !!this._messageId;
      let result: string | void = undefined;
      try {
        result = await this.flushCallback(snap, isEdit);
      } catch (err: any) {
        // Retry once for transient / retryable errors
        const code = err?.code ?? '';
        const retryable = err?.retryable || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
        if (retryable) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            result = await this.flushCallback(snap, isEdit);
          } catch {
            // give up after one retry
          }
        }
        // Defense-in-depth: never let a flush error become an unhandled rejection.
        // The next scheduled flush will catch up with the latest content.
      }
      if (!isEdit && typeof result === 'string') {
        this._messageId = result;
      }
    } finally {
      this.flushing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        try {
          const retrySnap = this.snapshot();
          if (retrySnap.phase !== 'starting' || retrySnap.totalTools > 0 || retrySnap.responseText) {
            await this.doFlush(retrySnap);
          }
        } catch {
          // Never let recursive flush errors propagate — the next scheduled
          // flush will pick up the latest content.
        }
      }
    }
  }
}
