import { CostTracker, type UsageStats } from './cost-tracker.js';
import { redactSensitiveContent } from './content-filter.js';
import { getToolIcon } from './tool-registry.js';

export interface MessageRendererOptions {
  platformLimit: number;
  throttleMs?: number;
  flushCallback: (
    content: string,
    isEdit: boolean,
    buttons?: Array<{ label: string; callbackData: string; style: string }>,
  ) => Promise<string | void>;
  /** Called when permission waits >60s without response */
  onPermissionTimeout?: (toolName: string, input: string, buttons: Array<{ label: string; callbackData: string; style: string }>) => void;
}

/** Tools silently ignored — never counted or displayed */
const HIDDEN_TOOLS = new Set([
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'TaskStop', 'TaskOutput', 'ToolSearch', 'TodoRead',
]);

const SEPARATOR = '───────────────';

interface PermissionState {
  toolName: string;
  input: string;
  permId: string;
  buttons: Array<{ label: string; callbackData: string; style: string }>;
}

export class MessageRenderer {
  private toolCounts = new Map<string, number>();
  private totalTools = 0;
  private responseText = '';
  private completed = false;
  private costLine?: string;
  private errorMessage?: string;
  private permissionQueue: PermissionState[] = [];

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

  onTextDelta(text: string): void {
    this.responseText += text;
    this.scheduleFlush();
  }

  onComplete(stats: UsageStats): void {
    this.completed = true;
    this.costLine = CostTracker.format(stats);
    this.stopTimers();
    const content = this.render();
    this.doFlush(content);
  }

  onError(error: string): void {
    this.errorMessage = error;
    this.stopTimers();
    const content = this.render();
    this.doFlush(content);
  }

  getResponseText(): string {
    return this.responseText;
  }

  dispose(): void {
    this.stopTimers();
  }

  // --- Internal ---

  private render(): string {
    // Error without tools
    if (this.errorMessage && this.totalTools === 0) {
      return this.applyPlatformLimit(redactSensitiveContent(`❌ ${this.errorMessage}`));
    }

    // Permission phase — show queue head, full command (user needs to assess risk)
    if (this.permissionQueue.length > 0) {
      const p = this.permissionQueue[0];
      const queueHint = this.permissionQueue.length > 1
        ? `\n⏳ +${this.permissionQueue.length - 1} more pending`
        : '';
      return this.applyPlatformLimit(redactSensitiveContent(`🔐 ${p.toolName}: ${p.input}${queueHint}`));
    }

    // Done phase (completed or error with tools)
    if (this.completed || this.errorMessage) {
      return this.renderDone();
    }

    // Executing phase
    return this.renderExecuting();
  }

  private renderExecuting(): string {
    if (this.totalTools === 0 && !this.responseText) {
      return '⏳ Starting...';
    }
    const lines: string[] = [];

    // Show response text above status line if available
    if (this.responseText.trim()) {
      lines.push(this.responseText.trim());
      lines.push('');
    }

    if (this.totalTools > 0) {
      const parts: string[] = [];
      for (const [name, count] of this.toolCounts) {
        parts.push(`${getToolIcon(name)} ${name} ×${count}`);
      }
      const toolSummary = parts.join(' · ');
      const elapsed = `${this.elapsedSeconds}s`;
      lines.push(`⏳ ${toolSummary} (${this.totalTools} tools · ${elapsed})`);
    }

    return this.applyPlatformLimit(redactSensitiveContent(lines.join('\n')));
  }

  private renderToolSummary(): string {
    const parts: string[] = [];
    for (const [name, count] of this.toolCounts) {
      parts.push(`${getToolIcon(name)} ${name} ×${count}`);
    }
    return `${parts.join(' · ')} (${this.totalTools} total)`;
  }

  private renderDone(): string {
    const lines: string[] = [];

    // Error with tools — show partial text + stopped + footer
    if (this.errorMessage) {
      if (this.responseText) {
        lines.push(this.responseText);
      }
      lines.push('⚠️ Stopped');
      lines.push(SEPARATOR);
      if (this.totalTools > 0) {
        lines.push(this.renderToolSummary());
      }
      if (this.costLine) {
        lines.push(this.costLine);
      }
      return this.applyPlatformLimit(redactSensitiveContent(lines.join('\n')));
    }

    // Completed — no platform limit applied here; bridge-manager handles overflow chunking
    if (this.responseText) {
      // Ensure text ends cleanly before separator (strip trailing whitespace but keep content)
      lines.push(this.responseText.trimEnd());
      lines.push(SEPARATOR);
    }
    if (this.totalTools > 0) {
      lines.push(this.renderToolSummary());
    }
    if (this.costLine) {
      lines.push(this.costLine);
    }
    return redactSensitiveContent(lines.join('\n'));
  }

  private applyPlatformLimit(content: string): string {
    if (content.length > this.platformLimit) {
      const tail = content.slice(-(this.platformLimit - 100));
      return '...\n' + tail;
    }
    return content;
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const content = this.render();
      this.doFlush(content);
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

  private async doFlush(content: string): Promise<void> {
    if (!content) return;
    if (this.flushing) {
      this.pendingFlush = true;
      return;
    }
    this.flushing = true;
    try {
      const isEdit = !!this._messageId;
      const flushButtons = this.permissionQueue[0]?.buttons;
      let result: string | void = undefined;
      try {
        result = await this.flushCallback(content, isEdit, flushButtons);
      } catch (err: any) {
        // Retry once for transient / retryable errors
        const code = err?.code ?? '';
        const retryable = err?.retryable || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
        if (retryable) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            result = await this.flushCallback(content, isEdit, flushButtons);
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
          const retryContent = this.render();
          if (retryContent) await this.doFlush(retryContent);
        } catch {
          // Never let recursive flush errors propagate — the next scheduled
          // flush will pick up the latest content.
        }
      }
    }
  }
}
