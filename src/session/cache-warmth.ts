// src/session/cache-warmth.ts
//
// Tracks Anthropic prompt-cache warmth: the cache expires ~5 minutes after
// the last assistant response, so we compute `warmUntilMs = last + 5min`.
// ActivityStickyRenderer consults `isWarm()` for the ⚡ vs ❄️ badge.
//
// When a workspace opts into prewarm, the PrewarmScheduler emits a no-op
// `sendInput('[tlive prewarm]')` via the warm pool at `warmUntilMs - 30s`
// to keep the cache hot indefinitely — cost is ~$0.0001 per tick. That
// runtime-side send is wired by SessionManager; this module only exposes
// the timing + notification surface so budget/ledger tests can reason
// about it without a real runtime.

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PREWARM_LEAD_MS = 30 * 1000;

export interface CacheWarmthEvent {
  kind: 'warmth_change';
  warmUntilMs: number | null;
}

export type CacheWarmthListener = (ev: CacheWarmthEvent) => void;

export interface CacheWarmthOptions {
  cacheTtlMs?: number;
  /** Fire a prewarm tick this many ms before expiry (default 30s). */
  prewarmLeadMs?: number;
  /** Override now() for tests. */
  now?: () => number;
}

export class CacheWarmth {
  private lastAssistantResponseAt: number | null = null;
  private readonly cacheTtlMs: number;
  private readonly prewarmLeadMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<CacheWarmthListener>();
  private prewarmTimer: NodeJS.Timeout | null = null;
  private prewarmHandler: (() => void) | null = null;

  constructor(opts: CacheWarmthOptions = {}) {
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.prewarmLeadMs = opts.prewarmLeadMs ?? DEFAULT_PREWARM_LEAD_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Called whenever the session observes an assistant turn's final text. */
  markAssistantResponse(at?: number): void {
    this.lastAssistantResponseAt = at ?? this.now();
    this.emit({ kind: 'warmth_change', warmUntilMs: this.warmUntilMs });
    this.reschedulePrewarm();
  }

  get warmUntilMs(): number | null {
    if (this.lastAssistantResponseAt === null) return null;
    return this.lastAssistantResponseAt + this.cacheTtlMs;
  }

  isWarm(): boolean {
    const until = this.warmUntilMs;
    return until !== null && this.now() < until;
  }

  remainingMs(): number {
    const until = this.warmUntilMs;
    if (until === null) return 0;
    return Math.max(0, until - this.now());
  }

  /** Register a prewarm handler invoked at `warmUntilMs - prewarmLeadMs`. */
  onPrewarmTick(handler: () => void): () => void {
    this.prewarmHandler = handler;
    this.reschedulePrewarm();
    return () => {
      this.prewarmHandler = null;
      this.clearPrewarmTimer();
    };
  }

  subscribe(cb: CacheWarmthListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Tear down timers (called by LocalSession.stop). */
  dispose(): void {
    this.clearPrewarmTimer();
    this.listeners.clear();
    this.prewarmHandler = null;
  }

  private reschedulePrewarm(): void {
    this.clearPrewarmTimer();
    if (!this.prewarmHandler || this.warmUntilMs === null) return;
    const fireAt = this.warmUntilMs - this.prewarmLeadMs;
    const delay = Math.max(0, fireAt - this.now());
    this.prewarmTimer = setTimeout(() => {
      this.prewarmTimer = null;
      try { this.prewarmHandler?.(); } catch { /* isolate */ }
    }, delay);
    if (this.prewarmTimer && typeof this.prewarmTimer.unref === 'function') {
      this.prewarmTimer.unref();
    }
  }

  private clearPrewarmTimer(): void {
    if (this.prewarmTimer) {
      clearTimeout(this.prewarmTimer);
      this.prewarmTimer = null;
    }
  }

  private emit(ev: CacheWarmthEvent): void {
    for (const l of this.listeners) { try { l(ev); } catch { /* isolate */ } }
  }
}
