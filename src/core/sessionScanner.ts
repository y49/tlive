import { watch, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

export interface SessionEvent {
  type: 'assistant' | 'user' | 'system' | 'result';
  uuid: string;
  message: unknown;
  raw: unknown;
}

export interface ToolUseEvent {
  toolUseId: string;
  toolName: string;
  input: unknown;
  timestamp: number;
}

export interface PendingPermission {
  toolUse: ToolUseEvent;
  timerId: ReturnType<typeof setTimeout>;
}

export interface ScannerOptions {
  sessionId: string;
  workdir: string;
  proactiveNotifyDelay?: number;   // default 60000ms
  proactiveQuestionDelay?: number; // default 5000ms
  pollingInterval?: number;        // fallback polling, default 3000ms
}

export class SessionScanner extends EventEmitter {
  private watcher: ReturnType<typeof watch> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private seenUUIDs = new Set<string>();
  private lastSize = 0;
  private pendingToolUse = new Map<string, PendingPermission>();
  private jsonlPath: string;
  private opts: Required<ScannerOptions>;

  constructor(opts: ScannerOptions) {
    super();
    this.opts = {
      proactiveNotifyDelay: 60000,
      proactiveQuestionDelay: 5000,
      pollingInterval: 3000,
      ...opts,
    };
    this.jsonlPath = this.resolveJsonlPath(opts.workdir, opts.sessionId);
  }

  get filePath(): string {
    return this.jsonlPath;
  }

  private resolveJsonlPath(workdir: string, sessionId: string): string {
    // Claude uses path-based directory names: /home/user/project → -home-user-project
    const projectDir = workdir.replace(/\//g, '-');
    return join(homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
  }

  start(): void {
    try {
      const dir = join(this.jsonlPath, '..');
      this.watcher = watch(dir, (eventType, filename) => {
        if (filename === basename(this.jsonlPath)) this.readNewLines();
      });
    } catch {
      // fs.watch not available
    }
    this.pollTimer = setInterval(() => this.readNewLines(), this.opts.pollingInterval);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const pending of this.pendingToolUse.values()) {
      clearTimeout(pending.timerId);
    }
    this.pendingToolUse.clear();
  }

  readNewLines(): void {
    if (!existsSync(this.jsonlPath)) return;
    const stat = statSync(this.jsonlPath);
    if (stat.size <= this.lastSize) return;

    const buf = Buffer.alloc(stat.size - this.lastSize);
    const fd = openSync(this.jsonlPath, 'r');
    readSync(fd, buf, 0, buf.length, this.lastSize);
    closeSync(fd);
    this.lastSize = stat.size;

    const lines = buf.toString('utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        this.processMessage(parsed);
      } catch { /* skip malformed */ }
    }
  }

  private processMessage(msg: Record<string, unknown>): void {
    const uuid = msg.uuid as string;
    if (!uuid || this.seenUUIDs.has(uuid)) return;
    this.seenUUIDs.add(uuid);

    const type = msg.type as string;
    if (type === 'system' || type === 'summary') return;

    const event: SessionEvent = { type: type as SessionEvent['type'], uuid, message: msg.message, raw: msg };
    this.emit('event', event);

    // Track tool_use from assistant
    if (type === 'assistant' && Array.isArray(msg.message)) {
      for (const block of msg.message as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use') this.trackToolUse(block);
      }
    }

    // Track tool_result — cancel pending
    if (type === 'result' || (type === 'user' && Array.isArray(msg.message))) {
      const blocks = Array.isArray(msg.message) ? msg.message as Array<Record<string, unknown>> : [];
      for (const block of blocks) {
        if (block.type === 'tool_result') this.resolveToolUse(block.tool_use_id as string);
      }
    }
  }

  private trackToolUse(block: Record<string, unknown>): void {
    const toolUseId = block.id as string;
    const toolName = block.name as string;
    if (!toolUseId) return;

    const isQuestion = toolName === 'AskUserQuestion';
    const delay = isQuestion ? this.opts.proactiveQuestionDelay : this.opts.proactiveNotifyDelay;

    const timerId = setTimeout(() => {
      const pending = this.pendingToolUse.get(toolUseId);
      if (pending) {
        this.pendingToolUse.delete(toolUseId);
        this.emit('permission_needed', pending.toolUse);
      }
    }, delay);

    this.pendingToolUse.set(toolUseId, {
      toolUse: { toolUseId, toolName, input: block.input, timestamp: Date.now() },
      timerId,
    });
  }

  private resolveToolUse(toolUseId: string): void {
    const pending = this.pendingToolUse.get(toolUseId);
    if (pending) {
      clearTimeout(pending.timerId);
      this.pendingToolUse.delete(toolUseId);
      this.emit('permission_resolved', toolUseId);
    }
  }
}
