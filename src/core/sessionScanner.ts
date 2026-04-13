import { BaseSessionScanner, type SessionFileScanResult } from './baseSessionScanner.js';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
  questionText?: string;
  questionOptions?: string[];
}

export interface PendingPermission {
  toolUse: ToolUseEvent;
  timerId: ReturnType<typeof setTimeout>;
}

export interface ScannerOptions {
  sessionId: string;
  /** Session directory (from ProviderAdapter.getSessionDir). Falls back to Claude default if omitted. */
  sessionDir?: string;
  workdir: string;
  proactiveNotifyDelay?: number;   // default 60000ms
  proactiveQuestionDelay?: number; // default 5000ms
  pollingInterval?: number;        // fallback polling, default 3000ms
}

export class SessionScanner extends EventEmitter {
  private readonly base: InternalBase;
  private readonly jsonlPath: string;
  private opts: Required<Omit<ScannerOptions, 'sessionDir'>>;
  private seenUUIDs = new Set<string>();
  private pendingToolUse = new Map<string, PendingPermission>();

  constructor(opts: ScannerOptions) {
    super();
    this.opts = {
      proactiveNotifyDelay: 60000,
      proactiveQuestionDelay: 5000,
      pollingInterval: 3000,
      ...opts,
    };
    const sessionDir = opts.sessionDir ?? this.defaultClaudeSessionDir(opts.workdir);
    this.jsonlPath = join(sessionDir, `${opts.sessionId}.jsonl`);
    this.base = new InternalBase(
      this.jsonlPath,
      this.opts.pollingInterval,
      (msg) => this.processMessage(msg),
    );
  }

  get filePath(): string {
    return this.jsonlPath;
  }

  /** Fire-and-forget — preserves existing non-async signature. */
  start(): void {
    void this.base.start();
  }

  stop(): void {
    this.base.stop();
    for (const pending of this.pendingToolUse.values()) {
      clearTimeout(pending.timerId);
    }
    this.pendingToolUse.clear();
  }

  /** Claude default — used when no sessionDir provided via adapter */
  private defaultClaudeSessionDir(workdir: string): string {
    const projectDir = resolve(workdir).replace(/[^a-zA-Z0-9-]/g, '-');
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectDir);
  }

  /**
   * Extract content blocks from a message.
   * Claude .jsonl format: { message: { role: "assistant", content: [...] } }
   * We need the content array.
   */
  private getContentBlocks(message: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(message)) return message;
    if (message && typeof message === 'object') {
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) return content;
    }
    return [];
  }

  private processMessage(msg: Record<string, unknown>): void {
    const uuid = msg.uuid as string;
    if (!uuid || this.seenUUIDs.has(uuid)) return;
    this.seenUUIDs.add(uuid);

    const type = msg.type as string;
    if (type === 'system' || type === 'summary') return;
    // Skip internal Claude events
    if (type === 'permission-mode' || type === 'file-history-snapshot' ||
        type === 'change' || type === 'queue-operation' || type === 'attachment') return;

    const event: SessionEvent = { type: type as SessionEvent['type'], uuid, message: msg.message, raw: msg };
    this.emit('event', event);

    const blocks = this.getContentBlocks(msg.message);

    // Track tool_use from assistant
    if (type === 'assistant') {
      for (const block of blocks) {
        if (block.type === 'tool_use') this.trackToolUse(block);
      }
      const messageObj = msg.message as Record<string, unknown> | undefined;
      if (messageObj && typeof messageObj === 'object') {
        const usage = (messageObj as any).usage;
        if (usage && typeof usage === 'object') this.emit('usage', usage);
        const model = (messageObj as any).model;
        if (typeof model === 'string') this.emit('model', model);
      }
    }

    // Track tool_result — cancel pending
    if (type === 'result' || type === 'user') {
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

    const toolUseEvent: ToolUseEvent = { toolUseId, toolName, input: block.input, timestamp: Date.now() };

    if (isQuestion) {
      // Real Claude format: { questions: [{ question, header, options: [{label}], multiSelect }] }
      const inputObj = block.input as Record<string, unknown>;
      const questions = inputObj?.questions as Array<Record<string, unknown>> | undefined;
      const firstQ = Array.isArray(questions) ? questions[0] : inputObj;
      toolUseEvent.questionText = (firstQ?.question as string) ?? '';
      const rawOptions = firstQ?.options;
      if (Array.isArray(rawOptions)) {
        toolUseEvent.questionOptions = rawOptions.map((o: any) => o.label ?? o.description ?? String(o));
      }
    }

    const timerId = setTimeout(() => {
      const pending = this.pendingToolUse.get(toolUseId);
      if (pending) {
        this.pendingToolUse.delete(toolUseId);
        this.emit('permission_needed', pending.toolUse);
      }
    }, delay);

    this.pendingToolUse.set(toolUseId, {
      toolUse: toolUseEvent,
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

/**
 * Internal adapter that routes BaseSessionScanner events into SessionScanner.processMessage.
 *
 * Dedup strategy: base class dedups on (filePath, lineIndex) — byte offset at line start,
 * monotonic per file. SessionScanner.processMessage adds a second dedup layer keyed by
 * `msg.uuid` so duplicate UUID payloads (which may land at different byte offsets) are
 * emitted only once.
 */
class InternalBase extends BaseSessionScanner<Record<string, unknown>> {
  constructor(
    private readonly filePath: string,
    pollingInterval: number,
    private readonly dispatch: (msg: Record<string, unknown>) => void,
  ) {
    super({ pollingInterval });
  }

  protected findSessionFiles(): string[] {
    // Always return the target path — file may not exist yet; parseSessionFile handles that.
    return [this.filePath];
  }

  protected parseSessionFile(filePath: string, cursor: number): SessionFileScanResult<Record<string, unknown>> {
    if (!existsSync(filePath)) return { events: [], nextCursor: cursor };
    const content = readFileSync(filePath, 'utf-8');
    const bytes = Buffer.byteLength(content);
    if (bytes <= cursor) return { events: [], nextCursor: bytes };
    const tail = content.slice(cursor);
    const lines = tail.split('\n').filter(Boolean);
    const events: Array<{ event: Record<string, unknown>; lineIndex: number }> = [];
    let idx = cursor; // lineIndex is monotonic per-file; reusing byte-offset-derived counter is fine for dedup
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        events.push({ event: parsed, lineIndex: idx++ });
      } catch {
        idx++;
        // skip malformed line but advance lineIndex so dedup keys remain unique
      }
    }
    return { events, nextCursor: bytes };
  }

  protected generateEventKey(_event: Record<string, unknown>, ctx: { filePath: string; lineIndex?: number }): string {
    // Rely on (filePath, lineIndex) for base-layer dedup. SessionScanner does uuid dedup on top.
    return `${ctx.filePath}:${ctx.lineIndex}`;
  }

  protected onEvent(event: Record<string, unknown>): void {
    this.dispatch(event);
  }
}
