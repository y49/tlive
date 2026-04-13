import { watch } from 'node:fs';

export interface SessionFileScanEntry<TEvent> {
  event: TEvent;
  lineIndex?: number;
}

export interface SessionFileScanResult<TEvent> {
  events: SessionFileScanEntry<TEvent>[];
  nextCursor: number;
}

export interface BaseSessionScannerOptions {
  /** Polling fallback interval when fs.watch is unavailable, ms. Default 3000. */
  pollingInterval?: number;
}

export abstract class BaseSessionScanner<TEvent> {
  private stopped = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watchers = new Map<string, { close(): void }>();
  private cursors = new Map<string, number>();
  private processedKeys = new Set<string>();
  private scanning = false;
  private pendingScan = false;

  constructor(private baseOpts: BaseSessionScannerOptions = {}) {}

  protected abstract findSessionFiles(): string[] | Promise<string[]>;
  protected abstract parseSessionFile(filePath: string, cursor: number): SessionFileScanResult<TEvent> | Promise<SessionFileScanResult<TEvent>>;
  protected abstract generateEventKey(event: TEvent, ctx: { filePath: string; lineIndex?: number }): string;
  protected abstract onEvent(event: TEvent, ctx: { filePath: string; lineIndex?: number }): void;

  async start(): Promise<void> {
    await this.scan();
    const interval = this.baseOpts.pollingInterval ?? 3000;
    this.pollTimer = setInterval(() => { this.scan().catch(() => {}); }, interval);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  /** For tests — run a single scan pass and await completion. */
  async triggerScan(): Promise<void> {
    await this.scan();
  }

  private async scan(): Promise<void> {
    if (this.stopped) return;
    if (this.scanning) { this.pendingScan = true; return; }
    this.scanning = true;
    try {
      const files = await this.findSessionFiles();
      for (const filePath of files) {
        this.ensureWatcher(filePath);
        const cursor = this.cursors.get(filePath) ?? 0;
        const { events, nextCursor } = await this.parseSessionFile(filePath, cursor);
        this.cursors.set(filePath, nextCursor);
        for (const entry of events) {
          const key = this.generateEventKey(entry.event, { filePath, lineIndex: entry.lineIndex });
          if (this.processedKeys.has(key)) continue;
          this.processedKeys.add(key);
          this.onEvent(entry.event, { filePath, lineIndex: entry.lineIndex });
        }
      }
    } finally {
      this.scanning = false;
      if (this.pendingScan) {
        this.pendingScan = false;
        await this.scan();
      }
    }
  }

  private ensureWatcher(filePath: string): void {
    if (this.watchers.has(filePath)) return;
    try {
      const w = watch(filePath, () => { this.scan().catch(() => {}); });
      this.watchers.set(filePath, { close: () => w.close() });
    } catch {
      // fs.watch unavailable — polling handles it
    }
  }
}
