// src/core/codexSessionScanner.ts

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  BaseSessionScanner,
  type SessionFileScanResult,
} from './baseSessionScanner.js';

export interface CodexScannerOptions {
  /** Session directory root (from CodexAdapter.getSessionDir()). */
  sessionDir: string;
  /** Ignore files older than this. Defaults to Date.now() at construction. */
  startupTimestampMs?: number;
  /** Polling interval ms; forwarded to BaseSessionScanner. */
  pollingInterval?: number;
}

export interface CodexEvent {
  type: string;
  uuid?: string;
  payload?: unknown;
  raw: Record<string, unknown>;
}

export class CodexSessionScanner extends EventEmitter {
  private readonly base: InternalBase;

  constructor(opts: CodexScannerOptions) {
    super();
    this.base = new InternalBase(opts, (evt) => {
      this.emit('event', evt);
      // Codex 0.121 emits token usage in event_msg/token_count events; forward
      // them as 'usage' so CostTracker (shared with Claude scanner path) can
      // accumulate input/output/cached token counts for the session summary.
      if (evt.type === 'event_msg') {
        const p = (evt.payload ?? {}) as Record<string, unknown>;
        if (p.type === 'token_count') {
          const info = (p.info ?? null) as Record<string, unknown> | null;
          const total = info?.total_token_usage as Record<string, unknown> | undefined;
          if (total) this.emit('usage', total);
        }
      }
    });
  }

  start(): Promise<void> {
    return this.base.start();
  }

  stop(): void {
    this.base.stop();
  }
}

class InternalBase extends BaseSessionScanner<CodexEvent> {
  private readonly cutoffMs: number;
  private readonly opts: CodexScannerOptions;
  private readonly dispatch: (evt: CodexEvent) => void;

  constructor(
    opts: CodexScannerOptions,
    dispatch: (evt: CodexEvent) => void,
  ) {
    super({ pollingInterval: opts.pollingInterval });
    this.opts = opts;
    this.dispatch = dispatch;
    this.cutoffMs = opts.startupTimestampMs ?? Date.now();
  }

  protected findSessionFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else if (name.endsWith('.jsonl') && st.mtimeMs >= this.cutoffMs) {
          out.push(full);
        }
      }
    };
    walk(this.opts.sessionDir, 0);
    return out;
  }

  protected parseSessionFile(
    filePath: string,
    cursor: number,
  ): SessionFileScanResult<CodexEvent> {
    let content = '';
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return { events: [], nextCursor: cursor };
    }
    const bytes = Buffer.byteLength(content);
    const tail = content.slice(cursor);
    const lines = tail.split('\n').filter(Boolean);
    const events = lines.flatMap((line, i) => {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const evt: CodexEvent = {
          type: String(raw.type ?? 'unknown'),
          uuid: (raw.id as string | undefined) ?? (raw.uuid as string | undefined),
          payload: raw.payload,
          raw,
        };
        return [{ event: evt, lineIndex: cursor + i }];
      } catch {
        return [];
      }
    });
    return { events, nextCursor: bytes };
  }

  protected generateEventKey(
    event: CodexEvent,
    ctx: { filePath: string; lineIndex?: number },
  ): string {
    return event.uuid
      ? `${ctx.filePath}:${event.uuid}`
      : `${ctx.filePath}:${ctx.lineIndex}`;
  }

  protected onEvent(event: CodexEvent): void {
    this.dispatch(event);
  }
}
